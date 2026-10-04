import { canClose, canOpen, fenceOf, type Fence } from './noteSections.js';

/** The parser in noteSections.ts treats `#` and `##` (up to three leading spaces) outside code fences as section headings. */
const TOP_LEVEL_HEADING_LINE = /^ {0,3}#{1,2}(?:[ \t]|$)/;

/** Escapes `#`/`##` heading lines and closes a code fence left open, so the text stays inside its own section. */
export function neutralizeSectionText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let openFence: Fence | undefined;

  const safeLines = lines.map((line) => {
    openFence = nextFenceState(openFence, fenceOf(line));
    return TOP_LEVEL_HEADING_LINE.test(line) ? `\\${line}` : line;
  });

  if (openFence) safeLines.push(openFence.character.repeat(openFence.length));
  return safeLines.join('\n');
}

/** Returns the fence open after `line`, using the same open/close rules as the section parser. */
function nextFenceState(openFence: Fence | undefined, lineFence: Fence | undefined): Fence | undefined {
  if (!lineFence) return openFence;
  if (!openFence) return canOpen(lineFence) ? lineFence : undefined;
  const closesOpenFence = canClose(lineFence) && lineFence.character === openFence.character && lineFence.length >= openFence.length;
  return closesOpenFence ? undefined : openFence;
}
