export interface InlineSegment { text: string; isCode: boolean; isBold: boolean }

/** A table cell is a list of lines: a `<br>` in the cell starts a new line. */
export type TableCell = InlineSegment[][];
export type TableAlignment = 'left' | 'right' | 'center' | null;

export type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3; segments: InlineSegment[] }
  | { type: 'paragraph'; segments: InlineSegment[] }
  | { type: 'list'; items: InlineSegment[][] }
  | { type: 'ordered-list'; start: number; items: InlineSegment[][] }
  | { type: 'quote'; blocks: MarkdownBlock[] }
  | { type: 'code'; text: string }
  | { type: 'table'; alignments: TableAlignment[]; header: TableCell[]; rows: TableCell[][] };

const HEADING = /^(#{1,3}) +(\S.*)$/;
const LIST_ITEM = /^[-*] +(.*)$/;
const ORDERED_ITEM = /^\d{1,9}\. +(.*)$/;
const QUOTE_LINE = /^> ?(.*)$/;
const NUMBER_THAT_CAN_INTERRUPT_A_PARAGRAPH = 1;
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;
const FENCE = '```';
const BACKTICK = '`';
const ASTERISK = '*';
const BOLD_MARKER = ASTERISK.repeat(2);
const NO_OPENER = -1;
const ZERO_WIDTH_CODE_POINTS = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff];
const ZERO_WIDTH_CHARACTERS = String.fromCodePoint(...ZERO_WIDTH_CODE_POINTS);
const BLANK_TEXT = new RegExp(`^[\\s${ZERO_WIDTH_CHARACTERS}]*$`);
const WHITESPACE = /^\s$/;
const PUNCTUATION = /^[\p{P}\p{S}]$/u;
const MAX_QUOTE_DEPTH = 3;
const TABLE_PIPE = '|';
const UNESCAPED_TABLE_PIPE = /(?<!\\)\|/;
const ESCAPED_TABLE_PIPE = /\\\|/g;
const TABLE_DELIMITER_CELL = /^:?-+:?$/;
const TABLE_LINE_BREAK = /<br\s*\/?>/i;

// ponytail: headings 1-3, paragraphs, bullet and numbered lists, quotes (3 levels), fenced code, GFM tables, inline code and bold only;
// no italics or links. Add `marked` if notes need them.
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

    if (canOpenQuote && startsQuote(line)) {
      const quotedLines: string[] = [];
      for (; index < lines.length && QUOTE_LINE.test(lines[index]!); index += 1) {
        quotedLines.push(QUOTE_LINE.exec(lines[index]!)![1]!);
      }
      blocks.push({ type: 'quote', blocks: parseLines(quotedLines, quoteDepth + 1) });
      continue;
    }

    if (startsTableAt(lines, index)) {
      const { table, next } = collectTable(lines, index, canOpenQuote);
      blocks.push(table);
      index = next;
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && startsParagraphContinuation(lines[index]!, canOpenQuote) && !startsTableAt(lines, index)) {
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

function startsTableAt(lines: string[], index: number): boolean {
  const headerLine = lines[index]!;
  const delimiterLine = lines[index + 1];
  if (delimiterLine === undefined) return false;
  const bothLinesHavePipes = headerLine.includes(TABLE_PIPE) && delimiterLine.includes(TABLE_PIPE);
  if (!bothLinesHavePipes) return false;
  const delimiterCells = tableRowCells(delimiterLine);
  const isDelimiterRow = delimiterCells.every((cell) => TABLE_DELIMITER_CELL.test(cell));
  const hasHeaderColumnCount = tableRowCells(headerLine).length === delimiterCells.length;
  return isDelimiterRow && hasHeaderColumnCount;
}

function collectTable(lines: string[], from: number, canOpenQuote: boolean): { table: MarkdownBlock; next: number } {
  const header = tableRowCells(lines[from]!).map(tableCell);
  const alignments = tableRowCells(lines[from + 1]!).map(alignmentOf);
  const rows: TableCell[][] = [];
  let next = from + 2;
  for (; next < lines.length && startsParagraphContinuation(lines[next]!, canOpenQuote); next += 1) {
    const cells = tableRowCells(lines[next]!);
    rows.push(header.map((_, column) => tableCell(cells[column] ?? '')));
  }
  return { table: { type: 'table', alignments, header, rows }, next };
}

/** Splits a table row on its unescaped pipes, ignoring the optional outer pipes; `\|` reads as a literal pipe. */
function tableRowCells(line: string): string[] {
  const trimmed = line.trim();
  const withoutLeadingPipe = trimmed.startsWith(TABLE_PIPE) ? trimmed.slice(1) : trimmed;
  const endsWithUnescapedPipe = withoutLeadingPipe.endsWith(TABLE_PIPE) && !withoutLeadingPipe.endsWith(`\\${TABLE_PIPE}`);
  const withoutOuterPipes = endsWithUnescapedPipe ? withoutLeadingPipe.slice(0, -1) : withoutLeadingPipe;
  return withoutOuterPipes.split(UNESCAPED_TABLE_PIPE).map((cell) => cell.trim().replace(ESCAPED_TABLE_PIPE, TABLE_PIPE));
}

function tableCell(cellText: string): TableCell {
  return cellText.split(TABLE_LINE_BREAK).map((lineText) => inlineSegments(lineText.trim()));
}

function alignmentOf(delimiterCell: string): TableAlignment {
  const isLeft = delimiterCell.startsWith(':');
  const isRight = delimiterCell.endsWith(':');
  if (isLeft && isRight) return 'center';
  if (isLeft) return 'left';
  return isRight ? 'right' : null;
}

function startsParagraphContinuation(line: string, canOpenQuote: boolean): boolean {
  const isBlank = line.trim() === '';
  const startsAnotherBlock =
    line.startsWith(FENCE) ||
    HEADING.test(line) ||
    LIST_ITEM.test(line) ||
    startsOrderedListThatCanInterrupt(line) ||
    (canOpenQuote && startsQuote(line));
  return !isBlank && !startsAnotherBlock;
}

function startsQuote(line: string): boolean {
  const quotedText = QUOTE_LINE.exec(line)?.[1];
  return quotedText !== undefined && quotedText.trim() !== '';
}

function startsOrderedListThatCanInterrupt(line: string): boolean {
  return ORDERED_ITEM.test(line) && Number.parseInt(line, 10) === NUMBER_THAT_CAN_INTERRUPT_A_PARAGRAPH;
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
  const segments: InlineSegment[] = [];
  let cursor = 0;
  for (const { openAt, closeAt } of findBoldPairs(text)) {
    segments.push({ text: text.slice(cursor, openAt), isCode: false, isBold: false });
    segments.push({ text: text.slice(openAt + BOLD_MARKER.length, closeAt), isCode: false, isBold: true });
    cursor = closeAt + BOLD_MARKER.length;
  }
  segments.push({ text: text.slice(cursor), isCode: false, isBold: false });
  return segments;
}

/**
 * Pairs the `**` markers that flank text CommonMark-style, in one left-to-right scan.
 * Only a run of exactly two asterisks is a marker; a marker with punctuation on both sides (a glob path) and a pair around blank content stay literal.
 */
function findBoldPairs(text: string): { openAt: number; closeAt: number }[] {
  const pairs: { openAt: number; closeAt: number }[] = [];
  let openAt = NO_OPENER;
  let runStart = text.indexOf(ASTERISK);
  while (runStart !== -1) {
    const runEnd = endOfAsteriskRun(text, runStart);
    const isBoldMarker = runEnd - runStart === BOLD_MARKER.length;
    if (isBoldMarker) {
      const { canOpen, canClose } = flankingOf(text, runStart, runEnd);
      const closesTheOpener = openAt !== NO_OPENER && canClose;
      if (closesTheOpener) {
        const isBlankContent = BLANK_TEXT.test(text.slice(openAt + BOLD_MARKER.length, runStart));
        if (!isBlankContent) pairs.push({ openAt, closeAt: runStart });
        openAt = NO_OPENER;
      } else if (canOpen) {
        openAt = runStart;
      }
    }
    runStart = text.indexOf(ASTERISK, runEnd);
  }
  return pairs;
}

function endOfAsteriskRun(text: string, runStart: number): number {
  let runEnd = runStart;
  while (text[runEnd] === ASTERISK) runEnd += 1;
  return runEnd;
}

function flankingOf(text: string, runStart: number, runEnd: number): { canOpen: boolean; canClose: boolean } {
  const before = characterKindOf(text[runStart - 1]);
  const after = characterKindOf(text[runEnd]);
  const isPunctuationOnBothSides = before === 'punctuation' && after === 'punctuation';
  return {
    canOpen: after !== 'space' && !isPunctuationOnBothSides,
    canClose: before !== 'space' && !isPunctuationOnBothSides,
  };
}

function characterKindOf(character: string | undefined): 'space' | 'punctuation' | 'word' {
  if (character === undefined || WHITESPACE.test(character)) return 'space';
  return PUNCTUATION.test(character) ? 'punctuation' : 'word';
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
    case 'table':
      return 1 + tableRowCost(block.header) + block.rows.reduce((total, row) => total + tableRowCost(row), 0);
    default:
      return 1;
  }
}

function tableRowCost(cells: readonly TableCell[]): number {
  const cellCosts = cells.map((cell) => 1 + cell.reduce((total, line) => total + countStyledRuns(line), 0));
  return 1 + cellCosts.reduce((total, cost) => total + cost, 0);
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
    case 'table': {
      const remainingForRows = budget - tableRowCost(block.header);
      const isHeaderCutOffFromItsTable = remainingForRows < 0;
      return isHeaderCutOffFromItsTable ? null : { ...block, rows: takeTableRows(block.rows, remainingForRows) };
    }
    default:
      return block;
  }
}

function takeTableRows(rows: readonly TableCell[][], budget: number): TableCell[][] {
  const kept: TableCell[][] = [];
  let remaining = budget;
  for (const row of rows) {
    const cost = tableRowCost(row);
    if (cost > remaining) break;
    remaining -= cost;
    kept.push(row);
  }
  return kept;
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
