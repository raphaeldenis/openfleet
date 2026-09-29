export interface InlineSegment { text: string; isCode: boolean; isBold: boolean }

export type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3; segments: InlineSegment[] }
  | { type: 'paragraph'; segments: InlineSegment[] }
  | { type: 'list'; items: InlineSegment[][] }
  | { type: 'ordered-list'; start: number; items: InlineSegment[][] }
  | { type: 'quote'; blocks: MarkdownBlock[] }
  | { type: 'code'; text: string };

const HEADING = /^(#{1,3}) +(.*)$/;
const LIST_ITEM = /^[-*] +(.*)$/;
const ORDERED_ITEM = /^\d{1,9}\. +(.*)$/;
const QUOTE_LINE = /^> ?(.*)$/;
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;
const FENCE = '```';
const BACKTICK = '`';
const BOLD_MARKER = '**';
const MAX_QUOTE_DEPTH = 3;

// ponytail: headings 1-3, paragraphs, bullet and numbered lists, quotes (3 levels), fenced code, inline code and bold only;
// no italics, links or tables. Add `marked` if notes need them.
export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  return parseLines(markdown.split(LINE_BREAK));
}

function parseLines(lines: string[], quoteDepth = 0): MarkdownBlock[] {
  const canOpenQuote = quoteDepth < MAX_QUOTE_DEPTH;
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    if (line.startsWith(FENCE)) {
      const closingIndex = findLine(lines, index + 1, (candidate) => candidate.startsWith(FENCE));
      const codeEnd = closingIndex === -1 ? lines.length : closingIndex;
      blocks.push({ type: 'code', text: lines.slice(index + 1, codeEnd).join('\n') });
      index = codeEnd + 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]!.length as 1 | 2 | 3, segments: inlineSegments(heading[2]!) });
      index += 1;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const { items, next } = collectListItems(lines, index, LIST_ITEM);
      blocks.push({ type: 'list', items });
      index = next;
      continue;
    }

    if (ORDERED_ITEM.test(line)) {
      const { items, next } = collectListItems(lines, index, ORDERED_ITEM);
      blocks.push({ type: 'ordered-list', start: Number.parseInt(line, 10), items });
      index = next;
      continue;
    }

    if (canOpenQuote && QUOTE_LINE.test(line)) {
      const quotedLines: string[] = [];
      for (; index < lines.length && QUOTE_LINE.test(lines[index]!); index += 1) {
        quotedLines.push(QUOTE_LINE.exec(lines[index]!)![1]!);
      }
      blocks.push({ type: 'quote', blocks: parseLines(quotedLines, quoteDepth + 1) });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && startsParagraphContinuation(lines[index]!, canOpenQuote)) {
      paragraphLines.push(lines[index]!);
      index += 1;
    }
    blocks.push({ type: 'paragraph', segments: inlineSegments(paragraphLines.join(' ')) });
  }

  return blocks;
}

function collectListItems(lines: string[], from: number, itemPattern: RegExp): { items: InlineSegment[][]; next: number } {
  const items: InlineSegment[][] = [];
  let next = from;
  for (; next < lines.length; next += 1) {
    const match = itemPattern.exec(lines[next]!);
    if (!match) break;
    items.push(inlineSegments(match[1]!));
  }
  return { items, next };
}

function startsParagraphContinuation(line: string, canOpenQuote: boolean): boolean {
  const isBlank = line.trim() === '';
  const startsAnotherBlock =
    line.startsWith(FENCE) || HEADING.test(line) || LIST_ITEM.test(line) || ORDERED_ITEM.test(line) || (canOpenQuote && QUOTE_LINE.test(line));
  return !isBlank && !startsAnotherBlock;
}

function findLine(lines: string[], from: number, matches: (line: string) => boolean): number {
  for (let index = from; index < lines.length; index += 1) {
    if (matches(lines[index]!)) return index;
  }
  return -1;
}

function inlineSegments(text: string): InlineSegment[] {
  return splitPairedBy(text, BACKTICK)
    .flatMap((piece) => (piece.isInside ? [{ text: piece.text, isCode: true, isBold: false }] : boldSegments(piece.text)))
    .filter((segment) => segment.text !== '')
    .reduce<InlineSegment[]>(mergeAdjacentTextSegments, []);
}

function boldSegments(text: string): InlineSegment[] {
  return splitPairedBy(text, BOLD_MARKER).map((piece) => {
    const isBoldWithoutContent = piece.isInside && piece.text.trim() === '';
    if (isBoldWithoutContent) return { text: `${BOLD_MARKER}${piece.text}${BOLD_MARKER}`, isCode: false, isBold: false };
    return { text: piece.text, isCode: false, isBold: piece.isInside };
  });
}

/** Splits on `delimiter`; odd pieces are inside a pair, and a delimiter left unpaired at the end stays literal text. */
function splitPairedBy(text: string, delimiter: string): { text: string; isInside: boolean }[] {
  const parts = text.split(delimiter);
  const hasUnpairedDelimiter = parts.length % 2 === 0;
  const pairedParts = hasUnpairedDelimiter ? [...parts.slice(0, -2), parts.slice(-2).join(delimiter)] : parts;
  return pairedParts.map((part, position) => ({ text: part, isInside: position % 2 === 1 }));
}

function mergeAdjacentTextSegments(merged: InlineSegment[], segment: InlineSegment): InlineSegment[] {
  const previous = merged.at(-1);
  const continuesPreviousRun = previous !== undefined && !previous.isCode && !segment.isCode && previous.isBold === segment.isBold;
  if (continuesPreviousRun) previous.text += segment.text;
  else merged.push({ ...segment });
  return merged;
}

/** Cost of a block in rendered DOM nodes worth budgeting: its own element, its list items, its quoted blocks and its inline code and bold runs. */
export function renderCost(block: MarkdownBlock): number {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
      return 1 + countStyledRuns(block.segments);
    case 'quote':
      return 1 + countRenderCost(block.blocks);
    case 'list':
    case 'ordered-list':
      return 1 + block.items.reduce((total, item) => total + 1 + countStyledRuns(item), 0);
    case 'code':
      return 1 + countLines(block.text);
    default:
      return 1;
  }
}

function countLines(text: string): number {
  if (text === '') return 0;
  let lineCount = 1;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lineCount += 1;
  return lineCount;
}

function takeLines(text: string, lineBudget: number): string {
  if (lineBudget <= 0) return '';
  let end = -1;
  for (let taken = 0; taken < lineBudget; taken += 1) {
    end = text.indexOf('\n', end + 1);
    if (end === -1) return text;
  }
  return text.slice(0, end);
}

export function countRenderCost(blocks: readonly MarkdownBlock[]): number {
  return blocks.reduce((total, block) => total + renderCost(block), 0);
}

/** Keeps the first `budget` rendered nodes in reading order, cutting inside lists, paragraphs and quotes. */
export function takeWithinRenderBudget(blocks: readonly MarkdownBlock[], budget: number): MarkdownBlock[] {
  const kept: MarkdownBlock[] = [];
  let remaining = budget;
  for (const block of blocks) {
    if (remaining <= 0) break;
    remaining -= 1;
    const trimmed = trimToBudget(block, remaining);
    const isHeaderCutOffFromItsContent = trimmed === null;
    if (isHeaderCutOffFromItsContent) break;
    remaining -= renderCost(trimmed) - 1;
    kept.push(trimmed);
  }
  return kept;
}

function trimToBudget(block: MarkdownBlock, budget: number): MarkdownBlock | null {
  switch (block.type) {
    case 'heading':
    case 'paragraph': {
      const segments = takeSegments(block.segments, budget);
      return block.segments.length > 0 && segments.length === 0 ? null : { ...block, segments };
    }
    case 'quote': {
      const nested = takeWithinRenderBudget(block.blocks, budget);
      return block.blocks.length > 0 && nested.length === 0 ? null : { ...block, blocks: nested };
    }
    case 'list':
    case 'ordered-list': {
      const items = takeListItems(block.items, budget);
      return block.items.length > 0 && items.length === 0 ? null : { ...block, items };
    }
    case 'code': {
      const text = takeLines(block.text, budget);
      return block.text !== '' && text === '' ? null : { ...block, text };
    }
    default:
      return block;
  }
}

function takeListItems(items: readonly InlineSegment[][], budget: number): InlineSegment[][] {
  const kept: InlineSegment[][] = [];
  let remaining = budget;
  for (const item of items) {
    if (remaining <= 0) break;
    remaining -= 1;
    const segments = takeSegments(item, remaining);
    const isBulletCutOffFromItsContent = item.length > 0 && segments.length === 0;
    if (isBulletCutOffFromItsContent) break;
    remaining -= countStyledRuns(segments);
    kept.push(segments);
  }
  return kept;
}

function takeSegments(segments: readonly InlineSegment[], budget: number): InlineSegment[] {
  const kept: InlineSegment[] = [];
  let remaining = budget;
  for (const segment of segments) {
    if (isStyledRun(segment)) {
      if (remaining <= 0) break;
      remaining -= 1;
    }
    kept.push(segment);
  }
  return kept;
}

function countStyledRuns(segments: readonly InlineSegment[]): number {
  return segments.filter(isStyledRun).length;
}

function isStyledRun(segment: InlineSegment): boolean {
  return segment.isCode || segment.isBold;
}
