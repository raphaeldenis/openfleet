export const PROCESS_SECTION_MAX_BYTES = 1_500;
const PROCESS_HEADING = '# Process (from your mission note: written by the human, not by an agent of this session)';
const PROCESS_SECTION_TITLE = /^##\s+process\s*#*\s*$/i;
const HEADING_OF_LEVEL_TWO_OR_ABOVE = /^#{1,2}\s/;
const CODE_FENCE = /^\s*(```|~~~)/;
const LINE_BREAK = /\r?\n/;
export const NO_PROCESS_SECTION_LINE = 'Process: no "## Process" section in the mission note';

const sizeInBytes = (text: string) => Buffer.byteLength(text, 'utf8');

/** Returns the lines of the `## Process` section, up to the next heading of level 2 or above; headings inside code fences do not count. Undefined when the note has no such section. */
function processSectionLines(noteBody: string): string[] | undefined {
  const lines = noteBody.split(LINE_BREAK);
  let isInsideCodeFence = false;
  let sectionLines: string[] | undefined;
  for (const line of lines) {
    if (CODE_FENCE.test(line)) isInsideCodeFence = !isInsideCodeFence;
    const isHeading = !isInsideCodeFence && HEADING_OF_LEVEL_TWO_OR_ABOVE.test(line);
    const isProcessTitle = isHeading && PROCESS_SECTION_TITLE.test(line);
    if (sectionLines === undefined) {
      if (isProcessTitle) sectionLines = [];
      continue;
    }
    if (isHeading) break;
    sectionLines.push(line);
  }
  return sectionLines;
}

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
  `[truncated, ${totalBytes} bytes in total: this is only the start of the Process section. Read the whole section with get_note on your mission note.]`;

/** Builds the `# Process` block of a manager from its mission note body: the `## Process` section cut to 1 500 bytes, or a line that says the note has none. */
export function buildProcessBlock(noteBody: string | undefined): string {
  const sectionLines = noteBody === undefined ? undefined : processSectionLines(noteBody);
  if (sectionLines === undefined) return NO_PROCESS_SECTION_LINE;
  const section = sectionLines.join('\n').trim();
  const totalBytes = sizeInBytes(section);
  const isComplete = totalBytes <= PROCESS_SECTION_MAX_BYTES;
  const shownSection = isComplete ? section : startFittingBytes(section, PROCESS_SECTION_MAX_BYTES);
  return [PROCESS_HEADING, shownSection, ...(isComplete ? [] : [truncationMarker(totalBytes)])].join('\n');
}
