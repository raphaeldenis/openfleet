import { MAX_MISSION_BYTES } from '@openfleet/shared';

export const MISSION_PREVIEW_BYTES = 3_000;
const MISSION_HEADING = '# Mission (the text stored for this manager: written by the human or imported from Scape notes, with its laws and exposed resources; not written by an agent of this session. It sits between the two fence lines and cannot end them)';
const MIN_FENCE_LENGTH = 6;
const FENCE_CHARACTER = '~';
const FENCE_CHARACTER_RUN = /~+/g;

export interface MissionBlock {
  text: string;
  /** Set when the stored mission is larger than a mission may be: the header of the context repeats it. */
  oversizeWarning: string | undefined;
}

const sizeInBytes = (text: string) => Buffer.byteLength(text, 'utf8');

/** Returns the longest start of the text that fits the byte limit, never cutting a character in two. */
function startFittingBytes(text: string, maxBytes: number): string {
  let start = '';
  let bytes = 0;
  for (const character of text) {
    bytes += sizeInBytes(character);
    if (bytes > maxBytes) break;
    start += character;
  }
  return start;
}

/** A fence made of more tildes than any run of tildes in the text, so that the text cannot close it. */
function fenceThatTextCannotClose(text: string): string {
  const longestRun = Math.max(0, ...(text.match(FENCE_CHARACTER_RUN) ?? []).map((run) => run.length));
  return FENCE_CHARACTER.repeat(Math.max(MIN_FENCE_LENGTH, longestRun + 1));
}

const truncationMarker = (totalBytes: number) =>
  `[truncated, ${totalBytes} bytes in total: this is only the start of your mission, not all of it. Read the whole mission with get_argus_status: manager.missionText.]`;

/**
 * Builds the `# Mission` block of a manager: the mission, or its first bytes, between two fence lines that the mission cannot close,
 * then, outside the fence, a marker that says the mission is not complete when it was cut.
 */
export function buildMissionBlock(missionText: string, { maxPreviewBytes }: { maxPreviewBytes: number }): MissionBlock {
  const totalBytes = sizeInBytes(missionText);
  const isComplete = totalBytes <= maxPreviewBytes;
  const shownText = isComplete ? missionText : startFittingBytes(missionText, maxPreviewBytes);
  const fence = fenceThatTextCannotClose(shownText);
  const fencedText = shownText === '' ? [] : [shownText];
  const lines = [MISSION_HEADING, fence, ...fencedText, fence, ...(isComplete ? [] : [truncationMarker(totalBytes)])];
  const isAboveMaximum = totalBytes > MAX_MISSION_BYTES;
  const oversizeWarning = isAboveMaximum ? `WARNING: the mission is ${totalBytes} bytes, above the ${MAX_MISSION_BYTES} bytes a mission may have: tell the human.` : undefined;
  return { text: lines.join('\n'), oversizeWarning };
}
