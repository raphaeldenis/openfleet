import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { NOTE_FOLDERS, type Note, type NoteFolder } from '@openfleet/shared';
import type { ProjectRecord, ProjectRepository } from '../projects/projectRepository.js';
import type { DocsFolderFs } from './docsFolderFs.js';
import { MAX_BODY_BYTES, NoteNotFoundError, NoteTooLargeError, StaleRevisionError, type NoteService } from './noteService.js';
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

export class NoteFileUnreadableError extends Error {
  constructor(path: string, cause: unknown) {
    super(`note file cannot be read: ${path}`, { cause });
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
  /** File-backed notes whose file is gone from disk — not healed, just surfaced. */
  missing: string[];
  /** File-backed notes whose file exists but cannot be read (permissions, I/O error) — not healed, just surfaced. */
  unreadable: string[];
  /** File-backed notes whose file path (or its directory) now resolves outside the docs folder — never read. */
  escaped: string[];
}

interface ImportCandidate {
  folder: NoteFolder;
  realFilePath: string;
  title: string;
}

/**
 * Per-project docs folder: notes backed by real markdown files, kept in sync with `notes.body_md`/`rev`
 * by one write-through path, one create path, and one external-edit path (Review Focus 1 and 5).
 *
 * **Containment**: every fs operation on a note's file — `writeThrough`, and `reconcileNote` whether
 * called from `reconcileOnBoot` or from `watch` — re-checks that the file's directory, and the file
 * itself if it exists, still realpath inside the project's docs folder before touching either. A docs
 * subfolder later swapped for a symlink (or a file itself replaced by one) is caught here: `writeThrough`
 * throws `PathEscapesDocsFolderError` before writing anything, and `reconcileNote` skips the note without
 * reading it, reporting its id in `escaped`. Nothing is ever read or written through an escaped path.
 *
 * **Write-through ordering** (`writeThrough`): the size cap is checked first, then a temp file is written
 * next to the target ('wx', fsynced — durable once `writeFileExclusiveSync` returns), THEN the DB row
 * (body + source_hash + rev CAS) and the rename of the temp file over the target run inside ONE
 * transaction, the rename last. On any failure the temp file is removed and the target is never touched —
 * a failed CAS, an oversized body, a vanished docs folder or a failed rename leaves neither the DB nor
 * the visible file changed (the revision and version row roll back with the failed rename). A docs folder
 * or subfolder that disappeared (ENOENT, ENOTDIR) surfaces as `NoteFileUnreadableError`; any other fs
 * failure (ENOSPC, EROFS, EACCES, EXDEV) propagates unchanged, so the caller sees an internal error.
 *
 * This order never leaves a mismatch `reconcileOnBoot` can't heal: before the rename, the target
 * file is untouched (nothing to reconcile — the write never happened as far as disk is concerned). Two
 * windows leave the file ahead of the DB, the file holding the new bytes while the DB still holds the old
 * body/hash: a crash between the rename and the transaction's COMMIT, and a COMMIT failure after a
 * successful rename. Until reconcile runs, a PATCH is refused with `stale_revision`. `reconcileOnBoot` hashes the actual file and compares it
 * to `notes.source_hash`; on a mismatch it always applies whatever is really on disk as a new 'disk'
 * revision (`applyExternalEdit`, decision 2) — so after reconcile, `source_hash` is by construction the
 * hash of the bytes reconcile just read, so the user's write is kept, never reverted. The whole sequence
 * is synchronous, so `watch`'s debounced hash comparison (the self-write guard) only runs after the
 * transaction has committed.
 *
 * **Create ordering** (`createFileBackedNote`) is the opposite: the size cap is checked, a temp file is
 * written, THEN renamed onto the (not-yet-existing) target, THEN the DB row is inserted. If the DB insert
 * fails, the just-renamed target is unlinked. A crash between the rename and the DB insert leaves a real
 * file with no DB row — that orphan is not reconciled, it heals the next time `attachFolder` (or a boot
 * pass over the docs folder) imports it as a brand new file, because nothing in the DB claims its path yet.
 *
 * **What `reconcileOnBoot`/`watch` heal vs. report**: a disk hash that no longer matches `source_hash` is
 * healed by applying it as a new 'disk' revision (`applied`), unless the new body is over the size cap
 * (`oversized`, left unchanged). A missing file (`missing`) and an escaped path (`escaped`) are never
 * healed — both are reported only, so the caller can surface them instead of the note silently drifting.
 */
export class DocsFolderService {
  constructor(private readonly deps: DocsFolderServiceDeps) {}

  ensureLayout(docsFolderPath: string): void {
    for (const folder of NOTE_FOLDERS) this.deps.fs.mkdirSync(join(docsFolderPath, folder));
  }

  createFileBackedNote(input: CreateFileBackedNoteInput): Note {
    this.assertWithinCap(input.bodyMd);
    const project = this.requireProject(input.projectId);
    const docsFolderPath = this.requireDocsFolderPath(project);
    const realDocsFolderPath = this.deps.fs.realpathSync(docsFolderPath);
    const realFolderDir = this.assertContained(realDocsFolderPath, join(docsFolderPath, input.folder));
    const dateStamp = this.deps.clock().slice(0, 10);
    const filePath = this.uniqueFilePath(realFolderDir, dateStamp, input.title);

    const tempPath = this.writeTempFile(filePath, input.bodyMd);
    this.deps.fs.renameSync(tempPath, filePath);
    try {
      return this.deps.notes.createFileBacked({
        projectId: input.projectId,
        title: input.title,
        bodyMd: input.bodyMd,
        folder: input.folder,
        shared: input.shared,
        author: input.author,
        filePath,
        sourceHash: sha256(input.bodyMd),
      });
    } catch (error) {
      this.deps.fs.unlinkSync(filePath);
      throw error;
    }
  }

  writeThrough(noteId: string, input: WriteThroughInput): Note {
    const current = this.requireFileBackedNote(noteId);
    const targetPath = current.filePath!;
    const project = this.requireProject(current.projectId);
    const docsFolderPath = this.requireDocsFolderPath(project);
    const realDocsFolderPath = this.orUnreadable(docsFolderPath, () => this.deps.fs.realpathSync(docsFolderPath));
    if (!this.isFileWithinDocsFolder(realDocsFolderPath, targetPath)) throw new PathEscapesDocsFolderError(targetPath);
    this.assertWithinCap(input.bodyMd);
    this.refuseIfDiskEditIsUnreconciled(current);

    const tempPath = this.orUnreadable(targetPath, () => this.writeTempFile(targetPath, input.bodyMd));
    try {
      return this.deps.notes.runAtomically(() => {
        const note = this.deps.notes.updateFileBacked(noteId, {
          bodyMd: input.bodyMd,
          sourceHash: sha256(input.bodyMd),
          expectedRev: input.expectedRev,
          author: input.author,
        });
        this.orUnreadable(targetPath, () => this.deps.fs.renameSync(tempPath, targetPath));
        return note;
      });
    } catch (error) {
      this.removeTempFileQuietly(tempPath);
      throw error;
    }
  }

  /** The note's file path relative to its project's docs folder; null for a plain note or a path outside the folder. */
  docsRelativePath(note: Note): string | null {
    if (!note.filePath) return null;
    const realDocsFolderPath = this.tryResolveRealDocsFolderPath(note.projectId);
    if (realDocsFolderPath === null) return null;
    if (!this.isPathContained(realDocsFolderPath, note.filePath)) return null;
    return note.filePath.slice(realDocsFolderPath.length + 1);
  }

  private tryResolveRealDocsFolderPath(projectId: string): string | null {
    try {
      return this.deps.fs.realpathSync(this.requireDocsFolderPath(this.requireProject(projectId)));
    } catch {
      return null;
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
    const report: ReconcileReport = { applied: [], oversized: [], missing: [], unreadable: [], escaped: [] };
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
    this.reconcileNote(note, { applied: [], oversized: [], missing: [], unreadable: [], escaped: [] });
  }

  /**
   * A disk hash equal to `note.sourceHash` is a no-op by construction — whether it's our own write's
   * rename firing the watcher, or a redundant OS notification (the self-write guard, decision 5): both
   * writeThrough and applyExternalEdit always leave `source_hash` equal to a fresh hash of the file they
   * just wrote, so nothing "changed" as far as the note is concerned.
   */
  private reconcileNote(note: Note, report: ReconcileReport): void {
    const project = this.requireProject(note.projectId);
    const realDocsFolderPath = this.deps.fs.realpathSync(this.requireDocsFolderPath(project));
    if (!this.isFileWithinDocsFolder(realDocsFolderPath, note.filePath!)) {
      report.escaped.push(note.id);
      return;
    }

    let diskBodyMd: string | undefined;
    try {
      diskBodyMd = this.tryReadFile(note.filePath!);
    } catch (error) {
      if (!(error instanceof NoteFileUnreadableError)) throw error;
      report.unreadable.push(note.id);
      return;
    }
    if (diskBodyMd === undefined) {
      report.missing.push(note.id);
      return;
    }
    const diskHash = sha256(diskBodyMd);
    if (diskHash === note.sourceHash) return;

    try {
      this.applyExternalEdit(note, diskBodyMd);
      report.applied.push(note.id);
    } catch (error) {
      if (error instanceof NoteTooLargeError) {
        report.oversized.push(note.id);
        return;
      }
      throw error;
    }
  }

  private applyExternalEdit(note: Note, diskBodyMd: string): Note {
    return this.deps.notes.updateFileBacked(note.id, {
      bodyMd: diskBodyMd,
      sourceHash: sha256(diskBodyMd),
      expectedRev: note.rev,
      author: EXTERNAL_EDIT_AUTHOR,
    });
  }

  /** A file changed on disk since the last write is recorded as a 'disk' revision, then the caller is refused so it re-reads. */
  private refuseIfDiskEditIsUnreconciled(note: Note): void {
    const diskBodyMd = this.tryReadFile(note.filePath!);
    const isFileMissing = diskBodyMd === undefined;
    if (isFileMissing || sha256(diskBodyMd) === note.sourceHash) return;
    const reconciled = this.applyExternalEdit(note, diskBodyMd);
    throw new StaleRevisionError(reconciled.rev);
  }

  /** Returns undefined only when the file does not exist; any other read failure throws `NoteFileUnreadableError`. */
  private tryReadFile(path: string): string | undefined {
    try {
      return this.deps.fs.readFileSync(path);
    } catch (error) {
      const isFileMissing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (isFileMissing) return undefined;
      throw new NoteFileUnreadableError(path, error);
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

  /** The filename on disk is left exactly as it is — only the derived title is NFC-normalized. */
  private titleFromFilename(filename: string): string {
    const withoutExtension = filename.replace(/\.md$/, '');
    const withoutDatePrefix = withoutExtension.replace(FILENAME_DATE_PREFIX, '');
    return withoutDatePrefix.replaceAll('-', ' ').normalize('NFC');
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

  /** A missing folder or file (ENOENT, ENOTDIR) reads as an unreadable note file; every other fs failure (full disk, permissions, EXDEV) propagates unchanged. */
  private orUnreadable<T>(path: string, run: () => T): T {
    try {
      return run();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const isMissingFolderOrFile = code === 'ENOENT' || code === 'ENOTDIR';
      if (!isMissingFolderOrFile) throw error;
      throw new NoteFileUnreadableError(path, error);
    }
  }

  private removeTempFileQuietly(tempPath: string): void {
    try {
      this.deps.fs.unlinkSync(tempPath);
    } catch {
      // the temp file's directory is already gone: nothing left to clean
    }
  }

  private writeTempFile(targetPath: string, contents: string): string {
    const tempPath = `${targetPath}.${randomUUID()}.tmp`;
    this.deps.fs.writeFileExclusiveSync(tempPath, contents);
    return tempPath;
  }

  private assertContained(realDocsFolderPath: string, candidatePath: string): string {
    const real = this.deps.fs.realpathSync(candidatePath);
    if (!this.isPathContained(realDocsFolderPath, real)) throw new PathEscapesDocsFolderError(candidatePath);
    return real;
  }

  /** Checks the file's directory, and the file itself if it exists, without ever throwing — the caller decides refuse vs. report. */
  private isFileWithinDocsFolder(realDocsFolderPath: string, filePath: string): boolean {
    if (!this.isPathContained(realDocsFolderPath, this.tryRealpath(dirname(filePath)))) return false;
    if (this.deps.fs.existsSync(filePath) && !this.isPathContained(realDocsFolderPath, this.tryRealpath(filePath))) return false;
    return true;
  }

  private isPathContained(realDocsFolderPath: string, realPath: string): boolean {
    return realPath === realDocsFolderPath || realPath.startsWith(`${realDocsFolderPath}/`);
  }

  /** A path that can't be resolved has nothing to escape through; the read/write attempt that follows fails on its own. */
  private tryRealpath(path: string): string {
    try {
      return this.deps.fs.realpathSync(path);
    } catch {
      return path;
    }
  }

  private assertWithinCap(bodyMd: string): void {
    const byteLength = Buffer.byteLength(bodyMd, 'utf8');
    if (byteLength > MAX_BODY_BYTES) throw new NoteTooLargeError(byteLength);
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
