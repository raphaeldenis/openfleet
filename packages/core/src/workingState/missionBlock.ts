import { MAX_MISSION_BYTES } from '@openfleet/shared';

const MISSION_PREVIEW_BYTES = 3_000;
const MISSION_HEADING = '# Mission (standing orders from the human who set you up)';

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

const truncationMarker = (totalBytes: number) =>
  `[truncated, ${totalBytes} bytes in total: this is only the start of your mission, not all of it. Read the whole mission with get_argus_status: manager.missionText.]`;

/** Builds the `# Mission` block of a manager: the whole mission when it is short, else its first 3,000 bytes and a marker that says it is not complete. */
export function buildMissionBlock(missionText: string): MissionBlock {
  const totalBytes = sizeInBytes(missionText);
  const isComplete = totalBytes <= MISSION_PREVIEW_BYTES;
  const body = isComplete ? [missionText] : [startFittingBytes(missionText, MISSION_PREVIEW_BYTES), truncationMarker(totalBytes)];
  const isAboveMaximum = totalBytes > MAX_MISSION_BYTES;
  const oversizeWarning = isAboveMaximum ? `WARNING: the mission is ${totalBytes} bytes, above the ${MAX_MISSION_BYTES} bytes a mission may have: tell the human.` : undefined;
  return { text: [MISSION_HEADING, ...body].join('\n'), oversizeWarning };
}
