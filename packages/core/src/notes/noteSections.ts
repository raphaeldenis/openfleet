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

interface LocatedSection {
  section: Section;
  lines: Line[];
  contentEnd: number;
}

const SECTION_LEVEL = 2;
const HEADING_PATTERN = /^(#{1,6})[ \t]+(.+?)[ \t]*$/;
const FENCE_OPENING_PATTERN = /^\s*(`{3,}|~{3,})/;
const FENCE_CLOSING_PATTERN = /^\s*(`{3,}|~{3,})\s*$/;
const LINE_BREAK_PATTERN = /\r?\n/;
const DEFAULT_LINE_BREAK = '\n';

export function listSections(bodyMd: string): Section[] {
  return sectionsOf(splitLines(bodyMd));
}

export function getSection(bodyMd: string, heading: string): string | undefined {
  const located = locateSection(splitLines(bodyMd), heading);
  if (!located) return undefined;

  const { section, lines, contentEnd } = located;
  const contentLines = lines.slice(section.startLine + 1, contentEnd);
  return joinLines(contentLines).replace(/\r?\n$/, '');
}

export function replaceSection(bodyMd: string, heading: string, newContent: string): string {
  const located = locateSection(splitLines(bodyMd), heading);
  if (!located) throw new Error(`section "${heading}" not found`);

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

  return joinLines(lines.slice(0, section.startLine)) + headingLine.text + headingLineBreak + newBlock + joinLines(followingLines);
}

export function appendSection(bodyMd: string, heading: string, content: string): string {
  const currentContent = getSection(bodyMd, heading);
  const lineBreak = firstLineBreakOf(bodyMd);

  if (currentContent === undefined) return appendNewSection(bodyMd, heading, content, lineBreak);

  const hasCurrentContent = currentContent !== '';
  const extendedContent = hasCurrentContent ? currentContent + lineBreak + content : content;
  return replaceSection(bodyMd, heading, extendedContent);
}

function appendNewSection(bodyMd: string, heading: string, content: string, lineBreak: string): string {
  const separator = separatorBeforeNewSection(splitLines(bodyMd), lineBreak);
  return bodyMd + separator + `## ${heading.trim()}` + lineBreak + normalizeLineBreaks(content, lineBreak);
}

function separatorBeforeNewSection(lines: Line[], lineBreak: string): string {
  const lastLine = lines.at(-1);
  if (!lastLine) return '';
  if (lastLine.lineBreak === '') return lineBreak + lineBreak;
  return isBlank(lastLine) ? '' : lineBreak;
}

function locateSection(lines: Line[], heading: string): LocatedSection | undefined {
  const wantedHeading = heading.trim();
  const section = sectionsOf(lines).find((candidate) => candidate.heading === wantedHeading);
  if (!section) return undefined;
  return { section, lines, contentEnd: endOfContent(lines, section) };
}

function endOfContent(lines: Line[], section: Section): number {
  const firstContentLine = section.startLine + 1;
  let contentEnd = section.endLine + 1;
  while (contentEnd > firstContentLine && isBlank(lines[contentEnd - 1]!)) contentEnd--;
  return contentEnd;
}

function sectionsOf(lines: Line[]): Section[] {
  const headings = findHeadingsOutsideFences(lines);
  const lastLineIndex = lines.length - 1;

  return headings.flatMap((heading, position) => {
    if (heading.level !== SECTION_LEVEL) return [];
    const nextBoundary = headings.slice(position + 1).find((later) => later.level <= SECTION_LEVEL);
    const endLine = nextBoundary ? nextBoundary.lineIndex - 1 : lastLineIndex;
    return [{ heading: heading.text, level: heading.level, startLine: heading.lineIndex, endLine }];
  });
}

function findHeadingsOutsideFences(lines: Line[]): Heading[] {
  const headings: Heading[] = [];
  let openFence: string | undefined;

  lines.forEach((line, lineIndex) => {
    if (openFence !== undefined) {
      if (closesFence(line.text, openFence)) openFence = undefined;
      return;
    }

    const fenceOpened = FENCE_OPENING_PATTERN.exec(line.text)?.[1];
    if (fenceOpened !== undefined) {
      openFence = fenceOpened;
      return;
    }

    const match = HEADING_PATTERN.exec(line.text);
    if (match) headings.push({ lineIndex, level: match[1]!.length, text: match[2]! });
  });

  return headings;
}

function closesFence(lineText: string, openFence: string): boolean {
  const closingRun = FENCE_CLOSING_PATTERN.exec(lineText)?.[1];
  if (closingRun === undefined) return false;
  const sameCharacter = closingRun[0] === openFence[0];
  return sameCharacter && closingRun.length >= openFence.length;
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
