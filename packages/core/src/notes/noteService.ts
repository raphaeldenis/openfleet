import type { DatabaseSync } from 'node:sqlite';
import type { Note, NoteChangeEvent, NoteChangeSource, NoteFolder } from '@openfleet/shared';
import { afterCommit, inTransaction as runInTransaction, recoverStuckTransaction } from '../db/transaction.js';
import { expandMentionBlocks, expandMentions, type MentionLookup } from './mentionExpander.js';
import type { NoteRepository, NoteUpdateResult } from './noteRepository.js';
import { appendSection, replaceSection } from './noteSections.js';

export const MAX_BODY_BYTES = 1024 * 1024;
// One first try plus three retries after a stale CAS (decision 2); a fourth loss means real contention, not luck.
const MAX_APPEND_ATTEMPTS = 4;
const SAVEPOINT_NAME = 'note_service_write';
const DEFAULT_CHANGE_SOURCE: NoteChangeSource = 'mcp';

export class StaleRevisionError extends Error {
  constructor(public readonly currentRev: number, public readonly conflictingSections: string[] = []) {
    super(`note revision is stale; current revision is ${currentRev}`);
  }
}

export class NoteNotFoundError extends Error {
  constructor(noteId: string) {
    super(`note not found: ${noteId}`);
  }
}

export class NoteTooLargeError extends Error {
  constructor(public readonly byteLength: number) {
    super(`note body is ${byteLength} bytes, over the ${MAX_BODY_BYTES}-byte cap`);
  }
}

export class FileBackedNoteError extends Error {
  constructor(noteId: string) {
    super(`note ${noteId} is file-backed; write through DocsFolderService instead`);
  }
}

export class VersionNotFoundError extends Error {
  constructor(rev: number) {
    super(`version not found: rev ${rev}`);
  }
}

export interface NoteServiceDeps {
  repo: NoteRepository;
  db: DatabaseSync;
  expandMentions: typeof expandMentions;
  expandMentionBlocks?: typeof expandMentionBlocks;
  clock: () => string;
  newId: () => string;
  /** Hears each committed write, once, after its transaction (and every transaction around it) has committed. */
  publishChange?: (event: NoteChangeEvent) => void;
}

/** Where a revisioned write comes from, announced with its `note.updated` event. */
interface WriteOrigin {
  source?: NoteChangeSource;
}

export interface CreateNoteInput {
  projectId: string;
  title: string;
  bodyMd: string;
  folder?: NoteFolder | null;
  shared?: boolean;
  author: string;
}

export interface CreateFileBackedNoteInput extends CreateNoteInput {
  filePath: string;
  sourceHash: string;
}

export interface UpdateFileBackedNoteInput extends WriteOrigin {
  bodyMd: string;
  sourceHash: string;
  expectedRev: number;
  author: string;
}

export interface UpdateNoteInput extends WriteOrigin {
  bodyMd: string;
  expectedRev: number;
  author: string;
}

export interface UpdateSectionInput extends WriteOrigin {
  heading: string;
  content: string;
  expectedRev: number;
  author: string;
}

export interface AppendNoteInput extends WriteOrigin {
  content: string;
  heading?: string;
  author: string;
}

export interface RenameNoteInput extends WriteOrigin {
  title: string;
  expectedRev: number;
  author: string;
}

export interface MoveNoteInput extends WriteOrigin {
  expectedRev?: number;
  author: string;
}

export interface GetExpandedOptions {
  viewerProjectId: string;
}

export interface ExpandedNote {
  note: Note;
  expandedBody: string;
}

export interface NoteWithMentionBlocks {
  note: Note;
  mentionBlocks: string[];
}

type AppendAttemptOutcome = { applied: true; note: Note } | { applied: false; currentRev: number };

/**
 * Orchestrates revisioned writes over notes: every write is compare-and-set against the caller's
 * expected revision (never merged, never silently overwritten) and, on success, records exactly one
 * note_versions row in the same transaction as the notes write. Ids and timestamps come from the
 * injected `newId`/`clock` so writes are deterministic under test.
 */
export class NoteService {
  private readonly repo: NoteRepository;
  private readonly db: DatabaseSync;
  private readonly expandMentions: typeof expandMentions;
  private readonly expandMentionBlocks: typeof expandMentionBlocks;
  private readonly clock: () => string;
  private readonly newId: () => string;
  private readonly publishChange: (event: NoteChangeEvent) => void;

  constructor(deps: NoteServiceDeps) {
    this.publishChange = deps.publishChange ?? (() => undefined);
    this.repo = deps.repo;
    this.db = deps.db;
    this.expandMentions = deps.expandMentions;
    this.expandMentionBlocks = deps.expandMentionBlocks ?? expandMentionBlocks;
    this.clock = deps.clock;
    this.newId = deps.newId;
  }

  create(input: CreateNoteInput): Note {
    assertWithinBodyCap(input.bodyMd);
    const now = this.clock();
    const note: Note = {
      id: this.newId(),
      projectId: input.projectId,
      title: input.title,
      bodyMd: input.bodyMd,
      folder: input.folder ?? null,
      filePath: null,
      sourceHash: null,
      rev: 1,
      shared: input.shared ?? false,
      createdAt: now,
      updatedAt: now,
    };
    return this.insertAnnouncingCreation(note, input.author, now);
  }

  /** Inserts a note that is file-backed from creation: `filePath`/`sourceHash` are set in the same INSERT, never patched in after. */
  createFileBacked(input: CreateFileBackedNoteInput): Note {
    assertWithinBodyCap(input.bodyMd);
    const now = this.clock();
    const note: Note = {
      id: this.newId(),
      projectId: input.projectId,
      title: input.title,
      bodyMd: input.bodyMd,
      folder: input.folder ?? null,
      filePath: input.filePath,
      sourceHash: input.sourceHash,
      rev: 1,
      shared: input.shared ?? false,
      createdAt: now,
      updatedAt: now,
    };
    return this.insertAnnouncingCreation(note, input.author, now);
  }

  /** Removes the note with its versions and search entry; returns false, announcing nothing, when it does not exist. */
  delete(id: string): boolean {
    return this.inTransaction(() => {
      const note = this.repo.get(id);
      if (!note) return false;
      this.repo.delete(id);
      this.announce({ type: 'note.deleted', noteId: note.id, projectId: note.projectId });
      return true;
    });
  }

  /** Same CAS write as `update`, but commits `sourceHash` alongside `bodyMd` in the one UPDATE (Review Focus 5). */
  updateFileBacked(id: string, input: UpdateFileBackedNoteInput): Note {
    assertWithinBodyCap(input.bodyMd);
    return this.writeThroughCas(id, input, (updatedAt) =>
      this.repo.updateFileBacked(id, { bodyMd: input.bodyMd, sourceHash: input.sourceHash, expectedRev: input.expectedRev, updatedAt }));
  }

  update(id: string, input: UpdateNoteInput): Note {
    assertWithinBodyCap(input.bodyMd);
    this.assertNotFileBacked(id);
    return this.writeThroughCas(id, input, (updatedAt) =>
      this.repo.update(id, { bodyMd: input.bodyMd, expectedRev: input.expectedRev, updatedAt }));
  }

  updateSection(id: string, input: UpdateSectionInput): Note {
    const current = this.require(id);
    this.assertNotFileBacked(id);
    const newBodyMd = replaceSection(current.bodyMd, input.heading, input.content);
    assertWithinBodyCap(newBodyMd);
    return this.writeThroughCas(id, input, (updatedAt) =>
      this.repo.update(id, { bodyMd: newBodyMd, expectedRev: input.expectedRev, updatedAt }));
  }

  append(id: string, input: AppendNoteInput): Note {
    this.assertNotFileBacked(id);
    let lastKnownRev: number | undefined;
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
      const outcome = this.tryAppendOnce(id, input);
      if (outcome.applied) return outcome.note;
      lastKnownRev = outcome.currentRev;
    }
    throw new StaleRevisionError(lastKnownRev!);
  }

  rename(id: string, input: RenameNoteInput): Note {
    this.assertNotFileBacked(id);
    return this.writeThroughCas(id, input, (updatedAt) =>
      this.repo.rename(id, { title: input.title, expectedRev: input.expectedRev, updatedAt }));
  }

  /** Replaces body and title under one revision check: one new revision, one version row. */
  updateBodyAndTitle(id: string, input: UpdateNoteInput & { title: string }): Note {
    assertWithinBodyCap(input.bodyMd);
    this.assertNotFileBacked(id);
    return this.writeThroughCas(id, input, (updatedAt) =>
      this.repo.updateBodyAndTitle(id, { bodyMd: input.bodyMd, title: input.title, expectedRev: input.expectedRev, updatedAt }));
  }

  /** A move is a revisioned write: without `expectedRev` it applies to the revision current inside the transaction. */
  move(id: string, folder: NoteFolder | null, input: MoveNoteInput): Note {
    this.assertNotFileBacked(id);
    return this.inTransaction(() => {
      const expectedRev = input.expectedRev ?? this.require(id).rev;
      return this.writeThroughCas(id, input, (updatedAt) =>
        this.repo.move(id, { folder, expectedRev, updatedAt }));
    });
  }

  /** Runs `work` in one transaction: a throw inside it rolls back every note write it made. */
  runAtomically<T>(work: () => T): T {
    return this.inTransaction(work);
  }

  /** Throws when a transaction is already open: a caller that does non-transactional work (a file rename) inside `runAtomically` cannot have an outer rollback undo it. */
  assertNoOuterTransaction(): void {
    recoverStuckTransaction(this.db);
    if (this.db.isTransaction) throw new Error('refusing to run inside an outer transaction: its rollback could not undo the file rename');
  }

  getExpanded(id: string, { viewerProjectId }: GetExpandedOptions): ExpandedNote {
    const note = this.require(id);
    const lookup = this.mentionLookupFor(viewerProjectId);
    const expandedBody = this.expandMentions(note.bodyMd, lookup, { rootNoteId: note.id });
    return { note, expandedBody };
  }

  /** The blocks `getExpanded` appends after the body, without repeating the body. */
  getMentionBlocks(id: string, { viewerProjectId }: GetExpandedOptions): NoteWithMentionBlocks {
    const note = this.require(id);
    const mentionBlocks = this.expandMentionBlocks(note.bodyMd, this.mentionLookupFor(viewerProjectId), { rootNoteId: note.id });
    return { note, mentionBlocks };
  }

  /** Unknown ids fall through to the CAS path's own NoteNotFoundError; only an existing, file-backed note is refused here. */
  private assertNotFileBacked(id: string): void {
    const note = this.repo.get(id);
    if (note?.filePath) throw new FileBackedNoteError(id);
  }

  private mentionLookupFor(viewerProjectId: string): MentionLookup {
    return {
      getNote: (mentionedId) => {
        const mentioned = this.repo.get(mentionedId);
        if (!mentioned) return undefined;
        const isVisibleToViewer = mentioned.projectId === viewerProjectId || mentioned.shared;
        if (!isVisibleToViewer) return undefined;
        return { id: mentioned.id, title: mentioned.title, bodyMd: mentioned.bodyMd, projectId: mentioned.projectId };
      },
      describeOther: () => undefined,
    };
  }

  private tryAppendOnce(id: string, input: AppendNoteInput): AppendAttemptOutcome {
    return this.inTransaction(() => {
      const current = this.require(id);
      const newBodyMd = input.heading === undefined
        ? appendToEndOfBody(current.bodyMd, input.content)
        : appendSection(current.bodyMd, input.heading, input.content);
      assertWithinBodyCap(newBodyMd);
      const updatedAt = this.clock();
      const result = this.repo.update(id, { bodyMd: newBodyMd, expectedRev: current.rev, updatedAt });
      if (result.outcome === 'not_found') throw new NoteNotFoundError(id);
      if (result.outcome === 'stale_revision') return { applied: false, currentRev: result.currentRev };
      this.insertVersionRow(result.note, input.author, updatedAt);
      this.announceUpdate(result.note, input);
      return { applied: true, note: result.note };
    });
  }

  private writeThroughCas(id: string, write: { author: string } & WriteOrigin, performCas: (updatedAt: string) => NoteUpdateResult): Note {
    return this.inTransaction(() => {
      const updatedAt = this.clock();
      const result = performCas(updatedAt);
      if (result.outcome === 'not_found') throw new NoteNotFoundError(id);
      if (result.outcome === 'stale_revision') throw new StaleRevisionError(result.currentRev);
      this.insertVersionRow(result.note, write.author, updatedAt);
      this.announceUpdate(result.note, write);
      return result.note;
    });
  }

  private insertAnnouncingCreation(note: Note, author: string, createdAt: string): Note {
    return this.inTransaction(() => {
      this.repo.insert(note);
      this.insertVersionRow(note, author, createdAt);
      this.announce({ type: 'note.created', noteId: note.id, projectId: note.projectId, rev: note.rev });
      return note;
    });
  }

  private announceUpdate(note: Note, { source = DEFAULT_CHANGE_SOURCE }: WriteOrigin): void {
    this.announce({ type: 'note.updated', noteId: note.id, projectId: note.projectId, rev: note.rev, source });
  }

  /** Hands the event to the listener once every transaction around the write has committed; a rollback drops it. */
  private announce(event: NoteChangeEvent): void {
    afterCommit(this.db, () => this.publishChange(event));
  }

  private insertVersionRow(note: Note, author: string, createdAt: string): void {
    this.repo.insertVersion({ id: this.newId(), noteId: note.id, rev: note.rev, bodyMd: note.bodyMd, author, createdAt });
  }

  private require(id: string): Note {
    const note = this.repo.get(id);
    if (!note) throw new NoteNotFoundError(id);
    return note;
  }

  private inTransaction<T>(work: () => T): T {
    return runInTransaction(this.db, SAVEPOINT_NAME, work);
  }
}

function assertWithinBodyCap(bodyMd: string): void {
  const byteLength = Buffer.byteLength(bodyMd, 'utf8');
  if (byteLength > MAX_BODY_BYTES) throw new NoteTooLargeError(byteLength);
}

function appendToEndOfBody(bodyMd: string, content: string): string {
  if (content === '') return bodyMd;
  if (bodyMd === '') return content;
  const bodyEndsWithNewline = bodyMd.endsWith('\n');
  return bodyEndsWithNewline ? bodyMd + content : `${bodyMd}\n${content}`;
}
