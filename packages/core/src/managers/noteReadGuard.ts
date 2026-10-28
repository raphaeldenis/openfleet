export type NoteNotReadEnforcement = 'warn_only' | 'refuse';

/** A manager that spawns without having read its mission note in full is warned with note_not_read; 'refuse' turns the warning into a refusal and is chosen by configuration only. */
export const NOTE_NOT_READ_ENFORCEMENT: NoteNotReadEnforcement = 'warn_only';

export type NoteReadVerdict = 'allow' | 'warn' | 'refuse';

/** The rule id under which the denial journal records a note_not_read warning. */
export const NOTE_NOT_READ_RULE_ID = 'note_not_read';

/** How far back the per-manager count of note_not_read warnings looks. */
export const NOTE_NOT_READ_WARNING_WINDOW_HOURS = 48;

type ByteRange = readonly [start: number, end: number];

/** What a manager has read of its mission note at one revision: the body bytes covered, and the mentions it still owes a read. */
export interface NoteReadProgress {
  noteId: string;
  rev: number;
  totalBytes: number;
  bodyRanges: ByteRange[];
  mentionIdsToRead: string[];
  mentionIdsRead: string[];
  /** The pages read so far of the mentions that page themselves, by mention id; absent in progress saved before pages were tracked. */
  mentionPages?: Record<string, { totalBytes: number; ranges: ByteRange[] }>;
}

/** What one get_note response shows of a read. */
export interface NoteReadEvent {
  start: number;
  end: number;
  totalBytes: number;
  /** The mentions the response leaves unread; undefined when the response does not say (a page after the first). */
  mentionIdsToRead: string[] | undefined;
  /** Whether the response holds the body and every mention expanded. */
  isWhole: boolean;
  /** Whether the response is one page of a body read with offset and bytes. */
  isPage: boolean;
}

const NOT_EXPANDED_MENTION = /@note:([^\s:]+): not expanded \((?:budget|depth)\)/g;

interface MentionsIndexEntry { id: string; type: string; readWith?: string }

/** The ids get_note can read: the resolved note mentions; a table, repo or playbook mention, or a note that does not resolve, has no get_note read. */
const mentionIdsOf = (mentionsIndex: unknown): string[] => {
  if (!Array.isArray(mentionsIndex)) return [];
  const readableNotes = (mentionsIndex as MentionsIndexEntry[]).filter(({ type, readWith }) => type === 'note' && readWith !== undefined);
  return readableNotes.map(({ id }) => id);
};

const notExpandedMentionIdsOf = (expandedBody: unknown): string[] =>
  typeof expandedBody === 'string' ? [...expandedBody.matchAll(NOT_EXPANDED_MENTION)].map((match) => match[1]!) : [];

/** Reads a get_note response as a read event; undefined when it carries no note body. */
export function noteReadEventOf(response: Record<string, unknown>): NoteReadEvent | undefined {
  const { bodyMd, complete, offset, bytes, totalBytes, mentionsIndex, expandedBody } = response;
  if (typeof bodyMd !== 'string') return undefined;

  const isPage = typeof offset === 'number' && typeof bytes === 'number' && typeof totalBytes === 'number';
  if (isPage) {
    const isFirstPage = Array.isArray(mentionsIndex);
    return { start: offset, end: offset + bytes, totalBytes, mentionIdsToRead: isFirstPage ? mentionIdsOf(mentionsIndex) : undefined, isWhole: false, isPage: true };
  }

  const bodyByteCount = Buffer.byteLength(bodyMd, 'utf8');
  const isBodyWithMentionsIndex = complete === false;
  if (isBodyWithMentionsIndex) return { start: 0, end: bodyByteCount, totalBytes: bodyByteCount, mentionIdsToRead: mentionIdsOf(mentionsIndex), isWhole: false, isPage: false };

  const cutMentionIds = notExpandedMentionIdsOf(expandedBody);
  return { start: 0, end: bodyByteCount, totalBytes: bodyByteCount, mentionIdsToRead: cutMentionIds, isWhole: cutMentionIds.length === 0, isPage: false };
}

function mergedRangesOf(ranges: ByteRange[]): ByteRange[] {
  const byStart = [...ranges].sort(([firstStart], [secondStart]) => firstStart - secondStart);
  return byStart.reduce<ByteRange[]>((merged, [start, end]) => {
    const last = merged.at(-1);
    const touchesLast = last !== undefined && start <= last[1];
    if (!touchesLast) return [...merged, [start, end]];
    return [...merged.slice(0, -1), [last[0], Math.max(last[1], end)]];
  }, []);
}

/** The progress after one read of the mission note; a read of another revision starts the progress again. */
export function progressAfterRead({ previous, noteId, rev, event }: { previous: NoteReadProgress | undefined; noteId: string; rev: number; event: NoteReadEvent }): NoteReadProgress {
  const continuesPrevious = previous !== undefined && previous.noteId === noteId && previous.rev === rev;
  const kept = continuesPrevious ? previous : { noteId, rev, totalBytes: event.totalBytes, bodyRanges: [], mentionIdsToRead: [], mentionIdsRead: [] };
  return {
    noteId, rev,
    totalBytes: event.totalBytes,
    bodyRanges: mergedRangesOf([...kept.bodyRanges, [event.start, event.end]]),
    mentionIdsToRead: event.mentionIdsToRead ?? kept.mentionIdsToRead,
    mentionIdsRead: kept.mentionIdsRead,
    mentionPages: kept.mentionPages,
  };
}

/** The progress after a mention of the mission note was read whole. */
export const progressAfterMentionRead = ({ previous, mentionId }: { previous: NoteReadProgress; mentionId: string }): NoteReadProgress =>
  previous.mentionIdsRead.includes(mentionId) ? previous : { ...previous, mentionIdsRead: [...previous.mentionIdsRead, mentionId] };

/** The progress after one page of a mention that pages itself; the mention counts as read once its contiguous pages cover [0, totalBytes]. */
export function progressAfterMentionPage({ previous, mentionId, event }: { previous: NoteReadProgress; mentionId: string; event: NoteReadEvent }): NoteReadProgress {
  const pagesBefore = previous.mentionPages?.[mentionId];
  const continuesPages = pagesBefore !== undefined && pagesBefore.totalBytes === event.totalBytes;
  const ranges = mergedRangesOf([...(continuesPages ? pagesBefore.ranges : []), [event.start, event.end]]);
  const [firstRange] = ranges;
  const coversMention = ranges.length === 1 && firstRange![0] === 0 && firstRange![1] >= event.totalBytes;
  const withPages = { ...previous, mentionPages: { ...previous.mentionPages, [mentionId]: { totalBytes: event.totalBytes, ranges } } };
  return coversMention ? progressAfterMentionRead({ previous: withPages, mentionId }) : withPages;
}

/** The progress after a get_note response of a mention the mission note owes: a page counts toward its pages, a response that delivers the entire body reads it (the mentions of the mention are not owed). */
export function progressAfterOwedMentionRead({ previous, mentionId, event }: { previous: NoteReadProgress; mentionId: string; event: NoteReadEvent }): NoteReadProgress {
  if (event.isPage) return progressAfterMentionPage({ previous, mentionId, event });
  return progressAfterMentionRead({ previous, mentionId });
}

/** Whether the progress covers every body byte of the note at this revision and every mention it names. */
export function isNoteReadInFull(progress: NoteReadProgress | undefined, { noteId, rev }: { noteId: string; rev: number }): boolean {
  if (progress === undefined) return false;
  const isCurrentNote = progress.noteId === noteId && progress.rev === rev;
  if (!isCurrentNote) return false;
  const [firstRange] = progress.bodyRanges;
  const coversBody = progress.bodyRanges.length === 1 && firstRange![0] === 0 && firstRange![1] >= progress.totalBytes;
  const leavesNoMentionUnread = progress.mentionIdsToRead.every((mentionId) => progress.mentionIdsRead.includes(mentionId));
  return coversBody && leavesNoMentionUnread;
}

/** Whether a manager that read `record.noteRead` may spawn while its linked mission note is at `currentNoteRev`. */
export function noteReadVerdictOf({ record, currentNoteRev, enforcement = NOTE_NOT_READ_ENFORCEMENT }: {
  record: { missionNoteId?: string; noteRead?: NoteReadProgress };
  currentNoteRev: number | undefined;
  enforcement?: NoteNotReadEnforcement;
}): NoteReadVerdict {
  const { missionNoteId, noteRead } = record;
  const hasNoNoteToRead = missionNoteId === undefined || currentNoteRev === undefined;
  if (hasNoNoteToRead) return 'allow';
  if (isNoteReadInFull(noteRead, { noteId: missionNoteId, rev: currentNoteRev })) return 'allow';
  return enforcement === 'refuse' ? 'refuse' : 'warn';
}
