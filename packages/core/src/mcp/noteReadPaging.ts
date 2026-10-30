/** The largest `get_note` response, in UTF-8 bytes of its JSON, that the agent harness shows whole instead of spilling to a file. */
export const NOTE_READ_SAFE_BYTES = 24 * 1024;
const NOTE_READ_MIN_BYTES = 2 * 1024;

const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_TAG = 0x80;

export interface MentionsIndexEntry {
  id: string;
  type: string;
  bytes: number;
  readWith?: string;
}

export const serializedBytes = (view: object) => Buffer.byteLength(JSON.stringify(view), 'utf8');

/** The cap a call runs under: `max_bytes` may lower the safe size, never raise it, and never go below the floor. */
export function readLimitBytes(requestedMaxBytes: number | undefined): number {
  if (requestedMaxBytes === undefined) return NOTE_READ_SAFE_BYTES;
  return Math.min(NOTE_READ_SAFE_BYTES, Math.max(NOTE_READ_MIN_BYTES, requestedMaxBytes));
}

/** The index entry an agent sees: a resolved mention says which call reads it. */
export const mentionsIndexEntryOf = ({ id, kind, bytes, isResolved }: { id: string; kind: string; bytes: number; isResolved: boolean }): MentionsIndexEntry =>
  ({ id, type: kind, bytes, ...(isResolved ? { readWith: `get_note note=${id}` } : {}) });

export type BodyField = 'bodyMd' | 'missionText';

interface NoteReadFraming {
  header: object;
  bodyMd: string;
  mentionsIndex: MentionsIndexEntry[];
  bodyField?: BodyField;
}

/** The body whole and the mentions as an index only: the mentions' content is read one `get_note` at a time. */
export const bodyWithMentionsIndexView = ({ header, bodyMd, mentionsIndex, bodyField = 'bodyMd' }: NoteReadFraming) => ({
  ...header, [bodyField]: bodyMd, complete: false, mentionsIndex,
  nextAction: 'the mentions are not expanded here: read each one with get_note note=<id> (mentionsIndex[].readWith)',
});

export interface BodyPageRequest extends NoteReadFraming {
  nextPageCall: (nextOffset: number) => string;
  offset: number;
  limitBytes: number;
}

export interface BoundedReadRequest {
  readFullView: () => object;
  readFraming: () => NoteReadFraming;
  nextPageCall: (nextOffset: number) => string;
  offset: number | undefined;
  limitBytes: number;
}

/**
 * Returns the whole read when it fits `limitBytes`; else the body with an index of its mentions when that fits; else one page of the body.
 * A read that continues from an offset is always a page.
 */
export function boundedReadView({ readFullView, readFraming, nextPageCall, offset, limitBytes }: BoundedReadRequest): object {
  const isReadingFromOffset = offset !== undefined && offset > 0;
  if (!isReadingFromOffset) {
    const fullView = readFullView();
    if (serializedBytes(fullView) <= limitBytes) return fullView;
  }

  const framing = readFraming();
  const bodyWithIndex = bodyWithMentionsIndexView(framing);
  if (!isReadingFromOffset && serializedBytes(bodyWithIndex) <= limitBytes) return bodyWithIndex;

  return bodyPageView({ nextPageCall, ...framing, offset: offset ?? 0, limitBytes });
}

/**
 * Returns the longest slice of the body, starting at `offset` (snapped down to a character start), whose whole response fits `limitBytes`.
 * `nextOffset` is exactly where the slice ends, so contiguous pages cover every byte of the body once.
 */
export function bodyPageView({ nextPageCall, header, bodyMd, mentionsIndex, offset, limitBytes, bodyField = 'bodyMd' }: BodyPageRequest) {
  const bodyBytes = Buffer.from(bodyMd, 'utf8');
  const totalBytes = bodyBytes.length;
  const start = alignDownToCharacterStart(bodyBytes, Math.min(offset, totalBytes));
  const isFirstPage = start === 0;

  const pageEndingAt = (end: number) => {
    const hasMore = end < totalBytes;
    return {
      ...header,
      [bodyField]: bodyBytes.toString('utf8', start, end),
      offset: start, bytes: end - start, totalBytes,
      truncated: hasMore, complete: false,
      ...(hasMore ? { nextOffset: end, nextAction: nextPageCall(end) } : {}),
      ...(isFirstPage ? { mentionsIndex } : {}),
    };
  };
  const fits = (end: number) => serializedBytes(pageEndingAt(end)) <= limitBytes;

  let longestFitting = start;
  let candidateCeiling = totalBytes;
  while (longestFitting < candidateCeiling) {
    const probe = Math.ceil((longestFitting + candidateCeiling) / 2);
    if (fits(alignDownToCharacterStart(bodyBytes, probe))) longestFitting = probe;
    else candidateCeiling = probe - 1;
  }

  const fittingEnd = alignDownToCharacterStart(bodyBytes, longestFitting);
  const makesNoProgress = fittingEnd === start && start < totalBytes;
  return pageEndingAt(makesNoProgress ? nextCharacterStart(bodyBytes, start) : fittingEnd);
}

const startsCharacter = (bytes: Buffer, position: number) =>
  position >= bytes.length || (bytes[position]! & UTF8_CONTINUATION_MASK) !== UTF8_CONTINUATION_TAG;

function alignDownToCharacterStart(bytes: Buffer, position: number): number {
  let aligned = position;
  while (!startsCharacter(bytes, aligned)) aligned -= 1;
  return aligned;
}

function nextCharacterStart(bytes: Buffer, position: number): number {
  let next = position + 1;
  while (!startsCharacter(bytes, next)) next += 1;
  return next;
}
