export interface Section {
  heading: string;
  level: number;
  startLine: number;
  endLine: number;
}

interface Line {
  text: string;
  lineBreak: string;
}

interface Heading {
  lineIndex: number;
  level: number;
  text: string;
}

export interface Fence {
  character: string;
  length: number;
  info: string;
}

interface Closer {
  index: number;
  length: number;
}

interface ParsedBody {
  lines: Line[];
  headings: Heading[];
}

interface LocatedSection {
  section: Section;
  sectionIndex: number;
  lines: Line[];
  contentEnd: number;
}

const SECTION_LEVEL = 2;
const HEADING_PATTERN = /^ {0,3}(#{1,2})(?:[ \t]+(.*))?$/s;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/s;
const BYTE_ORDER_MARK_PATTERN = /^\uFEFF/;
const LINE_BREAK_PATTERN = /\r?\n/;
const DEFAULT_LINE_BREAK = '\n';
const STRUCTURE_CHANGE_MESSAGE = 'content would change the section structure';

/** A section edit the caller can fix by changing its input; its message names only that input. */
export class SectionError extends Error {}

/**
 * Lists the `##` sections of a Markdown body, each with its 0-based first and last line.
 * Sections come from ATX headings (`#` or `##`, up to three leading spaces, optional closing `#`s)
 * found outside fenced code blocks; a fence that never closes is read as ordinary lines.
 * A `#` heading ends the preceding section without starting one of its own; a deeper heading
 * (`###` and beyond) is not recognized at all and stays inside the enclosing section's content.
 * Setext headings, HTML comments and front matter are not recognized.
 */
export function listSections(bodyMd: string): Section[] {
  const { lines, headings } = parse(bodyMd);
  return sectionsOf(headings, lines.length);
}

/** Returns the content under the first section titled `heading`, without the heading line or trailing blank lines. */
export function getSection(bodyMd: string, heading: string): string | undefined {
  const located = locateSection(parse(bodyMd), heading);
  return located && contentOf(located);
}

/** Replaces the content of the first section titled `heading`; throws when the result would change the heading structure. */
export function replaceSection(bodyMd: string, heading: string, newContent: string): string {
  const wantedHeading = requireSingleLineHeading(heading);
  const parsed = parse(bodyMd);
  const located = locateSection(parsed, wantedHeading);
  if (!located) throw new SectionError(`section "${heading}" not found`);
  if (newContent === contentOf(located)) return bodyMd;

  const { section, sectionIndex, lines, contentEnd } = located;
  const lineBreak = firstLineBreakOf(bodyMd);
  const headingLine = lines[section.startLine]!;
  const contentLines = lines.slice(section.startLine + 1, contentEnd);
  const followingLines = lines.slice(contentEnd);
  const lastContentLine = contentLines.at(-1);

  const hasNewContent = newContent !== '';
  const headingLineBreak = headingLine.lineBreak || (hasNewContent ? lineBreak : '');
  const contentLineBreak = lastContentLine?.lineBreak ?? (followingLines.length > 0 ? lineBreak : '');
  const newBlock = hasNewContent ? normalizeLineBreaks(newContent, lineBreak) + contentLineBreak : '';

  const replaced = joinLines(lines.slice(0, section.startLine)) + headingLine.text + headingLineBreak + newBlock + joinLines(followingLines);
  return ensureStructure(replaced, parsed, sectionIndex, outlineOf(parsed.headings));
}

/**
 * Appends `content` at the end of the first section titled `heading`, or in a new `##` section at the end of the body.
 * Existing bytes stay as they are; the appended text uses the first line break of the body.
 */
export function appendSection(bodyMd: string, heading: string, content: string): string {
  const wantedHeading = requireSingleLineHeading(heading);
  const parsed = parse(bodyMd);
  const located = locateSection(parsed, wantedHeading);
  const lineBreak = firstLineBreakOf(bodyMd);
  const newContent = normalizeLineBreaks(content, lineBreak);
  if (located && newContent === '') return bodyMd;

  if (!located) {
    const appended = appendNewSection(bodyMd, parsed.lines, wantedHeading, newContent, lineBreak);
    const outlineWithNewSection = [...outlineOf(parsed.headings), outlineEntry(SECTION_LEVEL, wantedHeading)];
    return ensureStructure(appended, parsed, undefined, outlineWithNewSection);
  }
  return ensureStructure(insertAtContentEnd(located, newContent, lineBreak), parsed, located.sectionIndex, outlineOf(parsed.headings));
}

function insertAtContentEnd({ lines, contentEnd }: LocatedSection, newContent: string, lineBreak: string): string {
  const previousLine = lines[contentEnd - 1]!;
  const isLastLineWithoutLineBreak = previousLine.lineBreak === '';
  const insertion = isLastLineWithoutLineBreak ? lineBreak + newContent : newContent + lineBreak;
  return joinLines(lines.slice(0, contentEnd)) + insertion + joinLines(lines.slice(contentEnd));
}

function appendNewSection(bodyMd: string, lines: Line[], heading: string, newContent: string, lineBreak: string): string {
  const separator = separatorBeforeNewSection(lines, lineBreak);
  return bodyMd + separator + `## ${heading}` + lineBreak + newContent;
}

function separatorBeforeNewSection(lines: Line[], lineBreak: string): string {
  const lastLine = lines.at(-1);
  if (!lastLine) return '';
  if (lastLine.lineBreak === '') return lineBreak + lineBreak;
  return isBlank(lastLine) ? '' : lineBreak;
}

function requireSingleLineHeading(heading: string): string {
  const trimmedHeading = heading.trim();
  const isSingleNonEmptyLine = trimmedHeading !== '' && !/[\r\n]/.test(trimmedHeading);
  if (!isSingleNonEmptyLine) throw new SectionError('heading must be a single non-empty line');

  const endsWithClosingHashes = titleOf(trimmedHeading) !== trimmedHeading;
  if (endsWithClosingHashes) throw new SectionError(`heading "${trimmedHeading}" must not end with closing #s`);
  return trimmedHeading;
}

function outlineOf(headings: Heading[]): string[] {
  return headings
    .filter((heading) => heading.level <= SECTION_LEVEL)
    .map((heading) => outlineEntry(heading.level, heading.text));
}

function outlineEntry(level: number, text: string): string {
  return `${level} ${text}`;
}

/**
 * Guards against both ways a section edit can corrupt structure: the outline (levels 1 and 2)
 * no longer matching `expectedOutline` — an old, cheap check, still needed since sections only
 * ever track `##` siblings, so it's the only guard left for a level-1 heading — and a `##`
 * sibling's own bytes changing, which a fence a splice opens or closes can cause by hiding or
 * revealing a sibling's heading while its heading TEXT coincidentally stays the same, something
 * outline comparison alone would miss (see the "structure invariant" fence repros in
 * noteSections.test.ts). `expectedOutline` is the caller's own outline, grown by one entry when
 * the edit creates a new section.
 */
function ensureStructure(newBodyMd: string, oldParsed: ParsedBody, targetIndex: number | undefined, expectedOutline: string[]): string {
  const newParsed = parse(newBodyMd);
  const outlineIsUnchanged = outlineOf(newParsed.headings).join('\n') === expectedOutline.join('\n');
  const siblingsAreUnchanged = siblingSectionsMatch(sectionTexts(oldParsed), sectionTexts(newParsed), targetIndex);
  if (!outlineIsUnchanged || !siblingsAreUnchanged) throw new SectionError(STRUCTURE_CHANGE_MESSAGE);
  return newBodyMd;
}

/**
 * Every section other than the one at `targetIndex` must be byte-identical, in the same order.
 * `targetIndex` is `undefined` when the edit creates a brand new section: every old section must
 * then be unchanged and the new body must have exactly one more section (the created one, last).
 */
function siblingSectionsMatch(oldSectionTexts: string[], newSectionTexts: string[], targetIndex: number | undefined): boolean {
  const isNewSection = targetIndex === undefined;
  const expectedSectionCount = oldSectionTexts.length + (isNewSection ? 1 : 0);
  if (newSectionTexts.length !== expectedSectionCount) return false;
  return oldSectionTexts.every((oldText, index) => index === targetIndex || newSectionTexts[index] === oldText);
}

/**
 * The text of each `##` section, heading line through its last non-blank line, in document order.
 * Trailing blank lines are trimmed (as `contentOf` already does for one section's own content), and
 * so is the one trailing line break past that: without it, the section that used to be last in a
 * body with no final line break would register as changed once appending a new section adds one.
 */
function sectionTexts({ lines, headings }: ParsedBody): string[] {
  return sectionsOf(headings, lines.length).map((section) =>
    joinLines(lines.slice(section.startLine, endOfContent(lines, section))).replace(/\r?\n$/, ''),
  );
}

function parse(bodyMd: string): ParsedBody {
  const lines = splitLines(bodyMd);
  return { lines, headings: parseHeadings(lines) };
}

function locateSection({ lines, headings }: ParsedBody, heading: string): LocatedSection | undefined {
  const wantedHeading = comparableHeading(heading);
  const sections = sectionsOf(headings, lines.length);
  const sectionIndex = sections.findIndex((candidate) => comparableHeading(candidate.heading) === wantedHeading);
  if (sectionIndex === -1) return undefined;
  const section = sections[sectionIndex]!;
  return { section, sectionIndex, lines, contentEnd: endOfContent(lines, section) };
}

function comparableHeading(heading: string): string {
  return heading.trim().normalize('NFC');
}

function contentOf({ section, lines, contentEnd }: LocatedSection): string {
  const contentLines = lines.slice(section.startLine + 1, contentEnd);
  return joinLines(contentLines).replace(/\r?\n$/, '');
}

function endOfContent(lines: Line[], section: Section): number {
  const firstContentLine = section.startLine + 1;
  let contentEnd = section.endLine + 1;
  while (contentEnd > firstContentLine && isBlank(lines[contentEnd - 1]!)) contentEnd--;
  return contentEnd;
}

function sectionsOf(headings: Heading[], lineCount: number): Section[] {
  const sections: Section[] = [];
  let endLine = lineCount - 1;

  for (let position = headings.length - 1; position >= 0; position--) {
    const heading = headings[position]!;
    if (heading.level === SECTION_LEVEL) sections.push({ heading: heading.text, level: heading.level, startLine: heading.lineIndex, endLine });
    endLine = heading.lineIndex - 1;
  }

  return sections.reverse();
}

function parseHeadings(lines: Line[]): Heading[] {
  const texts = lines.map((line, lineIndex) => (lineIndex === 0 ? line.text.replace(BYTE_ORDER_MARK_PATTERN, '') : line.text));
  const fenceClosingIndexes = closingIndexesOfFences(texts.map(fenceOf));
  const headings: Heading[] = [];

  for (let lineIndex = 0; lineIndex < texts.length; lineIndex++) {
    const fenceClosingIndex = fenceClosingIndexes[lineIndex];
    if (fenceClosingIndex !== undefined) {
      lineIndex = fenceClosingIndex;
      continue;
    }

    const match = HEADING_PATTERN.exec(texts[lineIndex]!);
    if (match) headings.push({ lineIndex, level: match[1]!.length, text: titleOf(match[2] ?? '') });
  }

  return headings;
}

/** Maps each line that opens a closed fence to the index of its closing line; one reverse pass over the lines. */
function closingIndexesOfFences(fences: (Fence | undefined)[]): (number | undefined)[] {
  const closingIndexes: (number | undefined)[] = [];
  const closersByCharacter = new Map<string, Closer[]>();

  for (let index = fences.length - 1; index >= 0; index--) {
    const fence = fences[index];
    if (!fence) continue;

    const closers = closersByCharacter.get(fence.character) ?? [];
    closersByCharacter.set(fence.character, closers);
    if (canOpen(fence)) closingIndexes[index] = nearestCloserAtLeast(closers, fence.length)?.index;
    if (canClose(fence)) pushCloser(closers, { index, length: fence.length });
  }

  return closingIndexes;
}

/** Keeps only the closers no later closer beats: nearest on top, lengths strictly increasing towards the bottom. */
function pushCloser(closers: Closer[], closer: Closer): void {
  while (closers.length > 0 && closers[closers.length - 1]!.length <= closer.length) closers.pop();
  closers.push(closer);
}

function nearestCloserAtLeast(closers: Closer[], length: number): Closer | undefined {
  let nearest: Closer | undefined;
  let low = 0;
  let high = closers.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (closers[middle]!.length >= length) {
      nearest = closers[middle];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return nearest;
}

export function fenceOf(text: string): Fence | undefined {
  const match = FENCE_PATTERN.exec(text);
  if (!match) return undefined;
  const marker = match[1]!;
  return { character: marker[0]!, length: marker.length, info: match[2]! };
}

export function canOpen(fence: Fence): boolean {
  const isBacktickFenceWithBacktickInInfo = fence.character === '`' && fence.info.includes('`');
  return !isBacktickFenceWithBacktickInInfo;
}

export function canClose(fence: Fence): boolean {
  return fence.info.trim() === '';
}

function titleOf(rawTitle: string): string {
  const title = rawTitle.trim();
  let closingHashesStart = title.length;
  while (closingHashesStart > 0 && title[closingHashesStart - 1] === '#') closingHashesStart--;

  const hasClosingHashes = closingHashesStart < title.length;
  const isSeparatedFromText = closingHashesStart === 0 || /[ \t]/.test(title[closingHashesStart - 1]!);
  return hasClosingHashes && isSeparatedFromText ? title.slice(0, closingHashesStart).trim() : title;
}

function splitLines(bodyMd: string): Line[] {
  const pieces = bodyMd.split(/(?<=\n)/).filter((piece) => piece !== '');
  return pieces.map((piece) => {
    const lineBreak = /\r?\n$/.exec(piece)?.[0] ?? '';
    return { text: piece.slice(0, piece.length - lineBreak.length), lineBreak };
  });
}

function joinLines(lines: Line[]): string {
  return lines.map((line) => line.text + line.lineBreak).join('');
}

function isBlank(line: Line): boolean {
  return line.text.trim() === '';
}

function firstLineBreakOf(bodyMd: string): string {
  return LINE_BREAK_PATTERN.exec(bodyMd)?.[0] ?? DEFAULT_LINE_BREAK;
}

function normalizeLineBreaks(content: string, lineBreak: string): string {
  return content.replace(/\r?\n/g, lineBreak);
}
