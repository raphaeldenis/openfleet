import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { NOTE_FOLDERS, type Note, type NoteFolder } from '@openfleet/shared';
import type { ProjectRecord, ProjectRepository } from '../projects/projectRepository.js';
import type { DocsFolderFs } from './docsFolderFs.js';
import { NoteNotFoundError, NoteTooLargeError, type NoteService } from './noteService.js';
import type { NoteRepository } from './noteRepository.js';

const IMPORT_AUTHOR = 'import';
const EXTERNAL_EDIT_AUTHOR = 'disk';
const DEBOUNCE_MS = 50;
const MAX_SLUG_SUFFIX_ATTEMPTS = 1000;
const FILENAME_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`project not found: ${projectId}`);
  }
}

export class ProjectHasNoDocsFolderError extends Error {
  constructor(projectId: string) {
    super(`project ${projectId} has no docs folder configured`);
  }
}

export class NoteIsNotFileBackedError extends Error {
  constructor(noteId: string) {
    super(`note ${noteId} is not file-backed`);
  }
}

export class PathEscapesDocsFolderError extends Error {
  constructor(path: string) {
    super(`path escapes the docs folder: ${path}`);
  }
}

export interface DocsFolderServiceDeps {
  notes: NoteService;
  noteRepo: NoteRepository;
  projects: ProjectRepository;
  fs: DocsFolderFs;
  /** ISO date-time source for the `YYYY-MM-DD` filename prefix; independent of NoteService's own clock. */
  clock: () => string;
}

export interface CreateFileBackedNoteInput {
  projectId: string;
  folder: NoteFolder;
  title: string;
  bodyMd: string;
  shared?: boolean;
  author: string;
}

export interface WriteThroughInput {
  bodyMd: string;
  expectedRev: number;
  author: string;
}

export interface ReconcileReport {
  applied: string[];
  oversized: string[];
}

interface ImportCandidate {
  folder: NoteFolder;
  realFilePath: string;
  title: string;
}

/**
 * Per-project docs folder: notes backed by real markdown files, kept in sync with `notes.body_md`/`rev`
 * by one write-through path and one external-edit path (Review Focus 1 and 5).
 *
 * **Write-through ordering** (`writeThrough`/`createFileBackedNote`): write a temp file next to the
 * target ('wx', fsynced — durable once `writeFileExclusiveSync` returns), THEN commit the DB row
 * (body + source_hash + rev CAS, one transaction), THEN rename the temp file over the target. On any
 * failure the temp file is removed and the target is never touched — a failed CAS or an oversized body
 * leaves neither the DB nor the visible file changed.
 *
 * This order never leaves a mismatch `reconcileOnBoot` can't heal: before the DB commits, the target
 * file is untouched (nothing to reconcile — the write never happened as far as disk is concerned); the
 * only crash window is between the DB commit and the rename, where the DB holds the new body/hash but
 * the target file still holds the old bytes. `reconcileOnBoot` hashes the actual file and compares it
 * to `notes.source_hash`; on a mismatch it always applies whatever is really on disk as a new 'disk'
 * revision (`applyExternalEdit`, decision 2) — so after reconcile, `source_hash` is by construction the
 * hash of the bytes reconcile just read. The attempted write is not lost: it is still the version row
 * the DB commit created, just superseded by the disk-observed revision. Renaming last also means the
 * file only changes at the very end, once our own DB bookkeeping is already committed — so `watch`'s
 * hash comparison (the self-write guard) never races an in-flight transaction of our own.
 */
export class DocsFolderService {
  constructor(private readonly deps: DocsFolderServiceDeps) {}

  ensureLayout(docsFolderPath: string): void {
    for (const folder of NOTE_FOLDERS) this.deps.fs.mkdirSync(join(docsFolderPath, folder));
  }

  createFileBackedNote(input: CreateFileBackedNoteInput): Note {
    const project = this.requireProject(input.projectId);
    const docsFolderPath = this.requireDocsFolderPath(project);
    const realDocsFolderPath = this.deps.fs.realpathSync(docsFolderPath);
    const realFolderDir = this.assertContained(realDocsFolderPath, join(docsFolderPath, input.folder));
    const dateStamp = this.deps.clock().slice(0, 10);
    const filePath = this.uniqueFilePath(realFolderDir, dateStamp, input.title);

    const tempPath = this.writeTempFile(filePath, input.bodyMd);
    try {
      const note = this.deps.notes.createFileBacked({
        projectId: input.projectId,
        title: input.title,
        bodyMd: input.bodyMd,
        folder: input.folder,
        shared: input.shared,
        author: input.author,
        filePath,
        sourceHash: sha256(input.bodyMd),
      });
      this.deps.fs.renameSync(tempPath, filePath);
      return note;
    } catch (error) {
      this.deps.fs.unlinkSync(tempPath);
      throw error;
    }
  }

  writeThrough(noteId: string, input: WriteThroughInput): Note {
    const current = this.requireFileBackedNote(noteId);
    const targetPath = current.filePath!;

    const tempPath = this.writeTempFile(targetPath, input.bodyMd);
    try {
      const note = this.deps.notes.updateFileBacked(noteId, {
        bodyMd: input.bodyMd,
        sourceHash: sha256(input.bodyMd),
        expectedRev: input.expectedRev,
        author: input.author,
      });
      this.deps.fs.renameSync(tempPath, targetPath);
      return note;
    } catch (error) {
      this.deps.fs.unlinkSync(tempPath);
      throw error;
    }
  }

  /** Imports every markdown file under `existingPath`'s four docs subfolders not already known by file_path. Idempotent. */
  attachFolder(projectId: string, existingPath: string): Note[] {
    this.requireProject(projectId);
    const realDocsFolderPath = this.deps.fs.realpathSync(existingPath);
    const candidates = this.scanImportCandidates(realDocsFolderPath);
    return candidates
      .filter((candidate) => !this.deps.noteRepo.getByFilePath(candidate.realFilePath))
      .flatMap((candidate) => this.importCandidate(projectId, candidate));
  }

  /** For every file-backed note of `projectId`: a disk hash that no longer matches `source_hash` is applied as a 'disk' revision. */
  reconcileOnBoot(projectId: string): ReconcileReport {
    const fileBackedNotes = this.deps.noteRepo.list(projectId).filter((note) => note.filePath !== null);
    const report: ReconcileReport = { applied: [], oversized: [] };
    for (const note of fileBackedNotes) this.reconcileNote(note, report);
    return report;
  }

  /** Watches the project's docs folder; each changed path is debounced and reconciled. Returns an unsubscribe that cancels pending work too. */
  watch(projectId: string): () => void {
    const project = this.requireProject(projectId);
    const docsFolderPath = this.requireDocsFolderPath(project);
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const stopWatching = this.deps.fs.watch(docsFolderPath, (_eventType, relativePath) => {
      if (relativePath === null) return;
      this.scheduleReconcile(join(docsFolderPath, relativePath), timers);
    });

    return () => {
      stopWatching();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }

  private scheduleReconcile(absolutePath: string, timers: Map<string, ReturnType<typeof setTimeout>>): void {
    const pending = timers.get(absolutePath);
    if (pending) clearTimeout(pending);
    timers.set(
      absolutePath,
      setTimeout(() => {
        timers.delete(absolutePath);
        this.reconcilePath(absolutePath);
      }, DEBOUNCE_MS),
    );
  }

  private reconcilePath(absolutePath: string): void {
    const note = this.deps.noteRepo.getByFilePath(absolutePath);
    if (!note) return;
    this.reconcileNote(note, { applied: [], oversized: [] });
  }

  /**
   * A disk hash equal to `note.sourceHash` is a no-op by construction — whether it's our own write's
   * rename firing the watcher, or a redundant OS notification (the self-write guard, decision 5): both
   * writeThrough and applyExternalEdit always leave `source_hash` equal to a fresh hash of the file they
   * just wrote, so nothing "changed" as far as the note is concerned.
   */
  private reconcileNote(note: Note, report: ReconcileReport): void {
    let diskBodyMd: string;
    try {
      diskBodyMd = this.deps.fs.readFileSync(note.filePath!);
    } catch {
      return; // ponytail: a deleted/unreadable file is out of scope for reconcile; it only heals content drift.
    }
    const diskHash = sha256(diskBodyMd);
    if (diskHash === note.sourceHash) return;

    try {
      this.deps.notes.updateFileBacked(note.id, { bodyMd: diskBodyMd, sourceHash: diskHash, expectedRev: note.rev, author: EXTERNAL_EDIT_AUTHOR });
      report.applied.push(note.id);
    } catch (error) {
      if (error instanceof NoteTooLargeError) {
        report.oversized.push(note.id);
        return;
      }
      throw error;
    }
  }

  private importCandidate(projectId: string, candidate: ImportCandidate): Note[] {
    let bodyMd: string;
    try {
      bodyMd = this.deps.fs.readFileSync(candidate.realFilePath);
    } catch {
      return [];
    }
    try {
      const note = this.deps.notes.createFileBacked({
        projectId,
        title: candidate.title,
        bodyMd,
        folder: candidate.folder,
        author: IMPORT_AUTHOR,
        filePath: candidate.realFilePath,
        sourceHash: sha256(bodyMd),
      });
      return [note];
    } catch (error) {
      if (error instanceof NoteTooLargeError) return []; // reported by absence: not in the returned array
      throw error;
    }
  }

  /** Resolves every subfolder AND every file's own path (a symlinked subfolder or file escaping the docs folder is refused). */
  private scanImportCandidates(realDocsFolderPath: string): ImportCandidate[] {
    return NOTE_FOLDERS.flatMap((folder) => {
      const declaredFolderDir = join(realDocsFolderPath, folder);
      const realFolderDir = this.deps.fs.realpathSync(declaredFolderDir);
      return this.deps.fs
        .listFilesSync(declaredFolderDir)
        .filter((filename) => filename.endsWith('.md'))
        .map((filename) => {
          const realFilePath = this.assertContained(realDocsFolderPath, join(realFolderDir, filename));
          return { folder, realFilePath, title: this.titleFromFilename(filename) };
        });
    });
  }

  private titleFromFilename(filename: string): string {
    const withoutExtension = filename.replace(/\.md$/, '');
    const withoutDatePrefix = withoutExtension.replace(FILENAME_DATE_PREFIX, '');
    return withoutDatePrefix.replaceAll('-', ' ');
  }

  private uniqueFilePath(realFolderDir: string, dateStamp: string, title: string): string {
    const slug = kebabSlug(title);
    for (let suffix = 0; suffix < MAX_SLUG_SUFFIX_ATTEMPTS; suffix++) {
      const filename = suffix === 0 ? `${dateStamp}-${slug}.md` : `${dateStamp}-${slug}-${suffix + 1}.md`;
      const candidate = join(realFolderDir, filename);
      if (!this.deps.fs.existsSync(candidate)) return candidate;
    }
    throw new Error(`could not find a free filename for "${title}" under ${realFolderDir}`);
  }

  private writeTempFile(targetPath: string, contents: string): string {
    const tempPath = `${targetPath}.${randomUUID()}.tmp`;
    this.deps.fs.writeFileExclusiveSync(tempPath, contents);
    return tempPath;
  }

  private assertContained(realDocsFolderPath: string, candidatePath: string): string {
    const real = this.deps.fs.realpathSync(candidatePath);
    const isContained = real === realDocsFolderPath || real.startsWith(`${realDocsFolderPath}/`);
    if (!isContained) throw new PathEscapesDocsFolderError(candidatePath);
    return real;
  }

  private requireProject(projectId: string): ProjectRecord {
    const project = this.deps.projects.get(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);
    return project;
  }

  private requireDocsFolderPath(project: ProjectRecord): string {
    if (!project.docsFolderPath) throw new ProjectHasNoDocsFolderError(project.id);
    return project.docsFolderPath;
  }

  private requireFileBackedNote(noteId: string): Note {
    const note = this.deps.noteRepo.get(noteId);
    if (!note) throw new NoteNotFoundError(noteId);
    if (!note.filePath) throw new NoteIsNotFileBackedError(noteId);
    return note;
  }
}

const ASCII_ONLY_PATTERN = /[^a-z0-9]+/g;
const DIACRITIC_MARKS_PATTERN = /[̀-ͯ]/g;
const SLUG_FALLBACK = 'note';

function kebabSlug(title: string): string {
  const asciiFolded = title.normalize('NFKD').replace(DIACRITIC_MARKS_PATTERN, '');
  const slug = asciiFolded.toLowerCase().replace(ASCII_ONLY_PATTERN, '-').replace(/^-+|-+$/g, '');
  return slug || SLUG_FALLBACK;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
