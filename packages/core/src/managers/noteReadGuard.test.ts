import { describe, expect, it } from 'vitest';
import {
  NOTE_NOT_READ_ENFORCEMENT, isNoteReadInFull, noteReadEventOf, noteReadVerdictOf, progressAfterMentionRead, progressAfterRead, type NoteReadEvent, type NoteReadProgress,
} from './noteReadGuard.js';

const MISSION_NOTE = { noteId: 'mission', rev: 3 };

const firstPage = { bodyMd: 'abcd', offset: 0, bytes: 4, totalBytes: 10, truncated: true, complete: false, nextOffset: 4, mentionsIndex: [{ id: 'm1', type: 'note', bytes: 5 }, { id: 'm2', type: 'note', bytes: 5 }] };

const readOf = (response: Record<string, unknown>): NoteReadEvent => noteReadEventOf(response)!;

const readingPages = (pages: Record<string, unknown>[]): NoteReadProgress | undefined =>
  pages.reduce<NoteReadProgress | undefined>((previous, page) => progressAfterRead({ previous, ...MISSION_NOTE, event: readOf(page) }), undefined);

describe('noteReadEventOf', () => {
  it('sees a response without complete false as a whole read of its body', () => {
    const event = readOf({ id: 'mission', rev: 3, bodyMd: 'héllo' });

    expect(event).toEqual({ start: 0, end: 6, totalBytes: 6, mentionIdsToRead: [], isWhole: true });
  });

  it('asks to read the mentions whose expansion was cut by the budget or the depth', () => {
    const event = readOf({ bodyMd: 'see', expandedBody: 'see\n\n--- @note:big: not expanded (budget) ---\n\n--- @note:deep: not expanded (depth) ---' });

    expect(event).toMatchObject({ isWhole: false, mentionIdsToRead: ['big', 'deep'] });
  });

  it('sees a page by its offset and its bytes, and carries the mentions index of the first page', () => {
    const event = readOf(firstPage);

    expect(event).toEqual({ start: 0, end: 4, totalBytes: 10, mentionIdsToRead: ['m1', 'm2'], isWhole: false });
  });

  it('sees a later page without a mentions index as not naming any mention', () => {
    const event = readOf({ bodyMd: 'efgh', offset: 4, bytes: 4, totalBytes: 10, complete: false, truncated: true, nextOffset: 8 });

    expect(event.mentionIdsToRead).toBeUndefined();
  });

  it('sees a body whole with a mentions index as a body read that leaves its mentions to read', () => {
    const event = readOf({ bodyMd: 'body', complete: false, mentionsIndex: [{ id: 'm1', type: 'note', bytes: 5 }] });

    expect(event).toEqual({ start: 0, end: 4, totalBytes: 4, mentionIdsToRead: ['m1'], isWhole: false });
  });

  it('sees nothing in a response that is not a note read', () => {
    expect(noteReadEventOf({ complete: false })).toBeUndefined();
  });
});

describe('isNoteReadInFull', () => {
  it('is false before any read', () => {
    expect(isNoteReadInFull(undefined, MISSION_NOTE)).toBe(false);
  });

  it('is true after a whole read', () => {
    const progress = readingPages([{ bodyMd: 'body' }]);

    expect(isNoteReadInFull(progress, MISSION_NOTE)).toBe(true);
  });

  it('is false while pages leave a gap, even when the last page was read', () => {
    const progress = readingPages([firstPage, { bodyMd: 'ij', offset: 8, bytes: 2, totalBytes: 10, complete: false, truncated: false }]);

    expect(isNoteReadInFull(progress, MISSION_NOTE)).toBe(false);
  });

  it('is false when the contiguous pages cover the body but a mention of the index is unread', () => {
    const progress = readingPages([firstPage, { bodyMd: 'efgh', offset: 4, bytes: 4, totalBytes: 10, complete: false, truncated: true, nextOffset: 8 }, { bodyMd: 'ij', offset: 8, bytes: 2, totalBytes: 10, complete: false, truncated: false }]);

    expect(isNoteReadInFull(progress, MISSION_NOTE)).toBe(false);
  });

  it('is true when contiguous pages cover [0, totalBytes] and every mention of the index was read whole', () => {
    const pages = readingPages([firstPage, { bodyMd: 'efgh', offset: 4, bytes: 4, totalBytes: 10, complete: false, truncated: true, nextOffset: 8 }, { bodyMd: 'ij', offset: 8, bytes: 2, totalBytes: 10, complete: false, truncated: false }])!;
    const progress = progressAfterMentionRead({ previous: progressAfterMentionRead({ previous: pages, mentionId: 'm1' }), mentionId: 'm2' });

    expect(isNoteReadInFull(progress, MISSION_NOTE)).toBe(true);
  });

  it('is true whatever the order of the pages', () => {
    const progress = readingPages([{ bodyMd: 'ij', offset: 8, bytes: 2, totalBytes: 10, complete: false, truncated: false }, { bodyMd: 'efgh', offset: 4, bytes: 4, totalBytes: 10, complete: false, truncated: true, nextOffset: 8 }, { ...firstPage, mentionsIndex: [] }]);

    expect(isNoteReadInFull(progress, MISSION_NOTE)).toBe(true);
  });

  it('is false when the note changed since the read', () => {
    const progress = readingPages([{ bodyMd: 'body' }]);

    expect(isNoteReadInFull(progress, { noteId: 'mission', rev: 4 })).toBe(false);
  });

  it('is false for another note than the one read', () => {
    const progress = readingPages([{ bodyMd: 'body' }]);

    expect(isNoteReadInFull(progress, { noteId: 'other', rev: 3 })).toBe(false);
  });

  it('starts again when a page of a new revision arrives', () => {
    const afterOldRevision = readingPages([{ bodyMd: 'body' }])!;

    const progress = progressAfterRead({ previous: afterOldRevision, noteId: 'mission', rev: 4, event: readOf({ ...firstPage, mentionsIndex: [] }) });

    expect(isNoteReadInFull(progress, { noteId: 'mission', rev: 4 })).toBe(false);
  });

  it('keeps a read incomplete when a mention was cut by the budget and never read', () => {
    const progress = readingPages([{ bodyMd: 'see', expandedBody: 'see\n\n--- @note:big: not expanded (budget) ---' }]);

    expect(isNoteReadInFull(progress, MISSION_NOTE)).toBe(false);
  });

  it('counts a mention read whole as read, but not a mention read incompletely', () => {
    const afterBody = readingPages([{ bodyMd: 'see', complete: false, mentionsIndex: [{ id: 'm1', type: 'note', bytes: 5 }] }])!;

    expect(isNoteReadInFull(progressAfterMentionRead({ previous: afterBody, mentionId: 'm1' }), MISSION_NOTE)).toBe(true);
    expect(isNoteReadInFull(afterBody, MISSION_NOTE)).toBe(false);
  });
});

describe('noteReadVerdictOf', () => {
  const missionNoteId = 'mission';
  const readInFull = readingPages([{ bodyMd: 'body' }]);

  it('allows a manager without a linked mission note', () => {
    expect(noteReadVerdictOf({ record: {}, currentNoteRev: undefined, enforcement: 'refuse' })).toBe('allow');
  });

  it('allows a manager whose linked note no longer exists', () => {
    expect(noteReadVerdictOf({ record: { missionNoteId }, currentNoteRev: undefined, enforcement: 'refuse' })).toBe('allow');
  });

  it('allows a manager that read the note in full at its current revision', () => {
    expect(noteReadVerdictOf({ record: { missionNoteId, noteRead: readInFull }, currentNoteRev: 3, enforcement: 'refuse' })).toBe('allow');
  });

  it('warns a manager that read nothing when the enforcement is warn_only', () => {
    expect(noteReadVerdictOf({ record: { missionNoteId }, currentNoteRev: 3, enforcement: 'warn_only' })).toBe('warn');
  });

  it('refuses a manager that read nothing when the enforcement is refuse', () => {
    expect(noteReadVerdictOf({ record: { missionNoteId }, currentNoteRev: 3, enforcement: 'refuse' })).toBe('refuse');
  });

  it('warns a manager whose full read is of an older revision', () => {
    expect(noteReadVerdictOf({ record: { missionNoteId, noteRead: readInFull }, currentNoteRev: 4, enforcement: 'warn_only' })).toBe('warn');
  });

  it('never refuses by default', () => {
    expect(NOTE_NOT_READ_ENFORCEMENT).toBe('warn_only');
    expect(noteReadVerdictOf({ record: { missionNoteId }, currentNoteRev: 3 })).toBe('warn');
  });
});
