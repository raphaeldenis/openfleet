import type { Note, Session } from '@openfleet/shared';
import type { DocsFolderService } from '../notes/docsFolderService.js';
import { NoteNotFoundError, type NoteService } from '../notes/noteService.js';
import type { NoteRepository } from '../notes/noteRepository.js';

export interface NoteToolDeps {
  notes: NoteService;
  noteRepo: NoteRepository;
  docs: DocsFolderService;
  caller: Session;
}

/** What every note tool shares: the caller's project scope, ownership lookup, the CAS write path, attribution and the public note shape. */
export function createNoteToolSupport({ notes, noteRepo, docs, caller }: NoteToolDeps) {
  const author = () => `${caller.emoji} ${caller.name}`;

  function requireProject(): { projectId: string } | undefined {
    return caller.projectId ? { projectId: caller.projectId } : undefined;
  }

  /** The one lookup every note tool starts from: an id from another project reads exactly like a missing one. */
  function requireOwnNote(projectId: string, id: string): Note {
    const note = noteRepo.get(id);
    if (!note || note.projectId !== projectId) throw new NoteNotFoundError(id);
    return note;
  }

  /** The one CAS write every body-changing tool commits through: same body, same rev check, file-backed or not. */
  function writeBody(current: Note, bodyMd: string, expectedRev: number): Note {
    const write = { bodyMd, expectedRev, author: author() };
    return current.filePath ? docs.writeThrough(current.id, write) : notes.update(current.id, write);
  }

  const noteSummary = (note: Note) => ({
    id: note.id, title: note.title, folder: note.folder, rev: note.rev, shared: note.shared, fileBacked: note.filePath !== null,
  });

  /** A note as `get_note` shows it: the summary plus its body, its path inside the docs folder when file-backed, and the expanded text only when a mention changed it. */
  const noteView = (note: Note, expandedBody: string) => {
    const docsRelativePath = docs.docsRelativePath(note);
    const hasExpandedMentions = expandedBody !== note.bodyMd;
    return {
      ...noteSummary(note), bodyMd: note.bodyMd,
      ...(docsRelativePath === null ? {} : { docsRelativePath }),
      ...(hasExpandedMentions ? { expandedBody } : {}),
    };
  };

  /** A note as `get_note` shows it with `mentions_only`: the body once, then the mention blocks alone, when there are any. */
  const noteMentionBlocksView = (note: Note, mentionBlocks: string[]) => {
    const docsRelativePath = docs.docsRelativePath(note);
    return {
      ...noteSummary(note), bodyMd: note.bodyMd,
      ...(docsRelativePath === null ? {} : { docsRelativePath }),
      ...(mentionBlocks.length > 0 ? { mentionBlocks } : {}),
    };
  };

  return { author, requireProject, requireOwnNote, writeBody, noteSummary, noteView, noteMentionBlocksView };
}
