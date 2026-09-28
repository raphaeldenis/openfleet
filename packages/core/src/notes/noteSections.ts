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

interface Fence {
  character: string;
  length: number;
  info: string;
}

interface ParsedBody {
  lines: Line[];
  headings: Heading[];
}

interface LocatedSection {
  section: Section;
  lines: Line[];
  contentEnd: number;
}

const SECTION_LEVEL = 2;
const HEADING_PATTERN = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/s;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/s;
const BYTE_ORDER_MARK_PATTERN = /^﻿/;
const LINE_BREAK_PATTERN = /\r?\n/;
const DEFAULT_LINE_BREAK = '\n';
const STRUCTURE_CHANGE_MESSAGE = 'content would change the section structure';

/**
 * Lists the `##` sections of a Markdown body, each with its 0-based first and last line.
 * Sections come from ATX headings (`#` to `######`, up to three leading spaces, optional closing `#`s)
 * found outside fenced code blocks; a fence that never closes is read as ordinary lines.
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
  if (!located) throw new Error(`section "${heading}" not found`);
  if (newContent === contentOf(located)) return bodyMd;

  const { section, lines, contentEnd } = located;
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
  return ensureOutline(replaced, outlineOf(parsed.headings));
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
  const outline = outlineOf(parsed.headings);

  if (!located) {
    const appended = appendNewSection(bodyMd, parsed.lines, wantedHeading, newContent, lineBreak);
    return ensureOutline(appended, [...outline, outlineEntry(SECTION_LEVEL, wantedHeading)]);
  }
  return ensureOutline(insertAtContentEnd(located, newContent, lineBreak), outline);
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
  if (!isSingleNonEmptyLine) throw new Error('heading must be a single non-empty line');
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

function ensureOutline(bodyMd: string, expectedOutline: string[]): string {
  const actualOutline = outlineOf(parse(bodyMd).headings);
  const hasExpectedStructure = actualOutline.join('\n') === expectedOutline.join('\n');
  if (!hasExpectedStructure) throw new Error(STRUCTURE_CHANGE_MESSAGE);
  return bodyMd;
}

function parse(bodyMd: string): ParsedBody {
  const lines = splitLines(bodyMd);
  return { lines, headings: parseHeadings(lines) };
}

function locateSection({ lines, headings }: ParsedBody, heading: string): LocatedSection | undefined {
  const wantedHeading = comparableHeading(heading);
  const section = sectionsOf(headings, lines.length).find((candidate) => comparableHeading(candidate.heading) === wantedHeading);
  if (!section) return undefined;
  return { section, lines, contentEnd: endOfContent(lines, section) };
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
    if (heading.level > SECTION_LEVEL) continue;
    if (heading.level === SECTION_LEVEL) sections.push({ heading: heading.text, level: heading.level, startLine: heading.lineIndex, endLine });
    endLine = heading.lineIndex - 1;
  }

  return sections.reverse();
}

function parseHeadings(lines: Line[]): Heading[] {
  const texts = lines.map((line, lineIndex) => (lineIndex === 0 ? line.text.replace(BYTE_ORDER_MARK_PATTERN, '') : line.text));
  const headings: Heading[] = [];

  for (let lineIndex = 0; lineIndex < texts.length; lineIndex++) {
    const fenceClosingIndex = closingIndexOfFenceOpenedAt(texts, lineIndex);
    if (fenceClosingIndex !== undefined) {
      lineIndex = fenceClosingIndex;
      continue;
    }

    const match = HEADING_PATTERN.exec(texts[lineIndex]!);
    if (match) headings.push({ lineIndex, level: match[1]!.length, text: titleOf(match[2] ?? '') });
  }

  return headings;
}

// ponytail: an opener without a closer rescans to the end, quadratic only on a body made of unclosed fences
function closingIndexOfFenceOpenedAt(texts: string[], openerIndex: number): number | undefined {
  const opener = fenceOf(texts[openerIndex]!);
  if (!opener || !canOpen(opener)) return undefined;

  for (let index = openerIndex + 1; index < texts.length; index++) {
    const candidate = fenceOf(texts[index]!);
    if (candidate && closes(candidate, opener)) return index;
  }
  return undefined;
}

function fenceOf(text: string): Fence | undefined {
  const match = FENCE_PATTERN.exec(text);
  if (!match) return undefined;
  const marker = match[1]!;
  return { character: marker[0]!, length: marker.length, info: match[2]! };
}

function canOpen(fence: Fence): boolean {
  const isBacktickFenceWithBacktickInInfo = fence.character === '`' && fence.info.includes('`');
  return !isBacktickFenceWithBacktickInInfo;
}

function closes(candidate: Fence, opener: Fence): boolean {
  const isSameCharacter = candidate.character === opener.character;
  const isLongEnough = candidate.length >= opener.length;
  const hasNoInfo = candidate.info.trim() === '';
  return isSameCharacter && isLongEnough && hasNoInfo;
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
