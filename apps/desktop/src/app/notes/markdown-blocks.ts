export interface InlineSegment { text: string; isCode: boolean }

export type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3; segments: InlineSegment[] }
  | { type: 'paragraph'; segments: InlineSegment[] }
  | { type: 'list'; items: InlineSegment[][] }
  | { type: 'code'; text: string }
  | { type: 'mention-note'; kind: string; id: string; title: string; blocks: MarkdownBlock[] }
  | { type: 'mention-line'; kind: string; id: string; text: string };

const HEADING = /^(#{1,3}) +(.*)$/;
const LIST_ITEM = /^[-*] +(.*)$/;
const FENCE = '```';
const NOTE_BLOCK_START = /^--- from note @(\w+):([\w-]+) \((.*), [^,]*\) ---$/;
const MENTION_LINE = /^--- @(\w+):([\w-]+)(?::| →) ?(.*?) ---$/;

// ponytail: headings 1-3, paragraphs, bullet lists, fenced code, inline code and mention blocks only;
// no emphasis, links or tables. Add `marked` if notes need them.
export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  return parseLines(markdown.split('\n'));
}

function parseLines(lines: string[]): MarkdownBlock[] {
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

    const noteBlockStart = NOTE_BLOCK_START.exec(line);
    if (noteBlockStart) {
      const [, kind, id, title] = noteBlockStart;
      const endMarker = `--- end @${kind}:${id} ---`;
      const closingIndex = findLine(lines, index + 1, (candidate) => candidate === endMarker);
      const bodyEnd = closingIndex === -1 ? lines.length : closingIndex;
      blocks.push({ type: 'mention-note', kind: kind!, id: id!, title: title!, blocks: parseLines(lines.slice(index + 1, bodyEnd)) });
      index = bodyEnd + 1;
      continue;
    }

    const mentionLine = MENTION_LINE.exec(line);
    if (mentionLine) {
      const [, kind, id, text] = mentionLine;
      blocks.push({ type: 'mention-line', kind: kind!, id: id!, text: text! });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]!.length as 1 | 2 | 3, segments: inlineSegments(heading[2]!) });
      index += 1;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const items: InlineSegment[][] = [];
      while (index < lines.length && LIST_ITEM.test(lines[index]!)) {
        items.push(inlineSegments(LIST_ITEM.exec(lines[index]!)![1]!));
        index += 1;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && startsParagraphContinuation(lines[index]!)) {
      paragraphLines.push(lines[index]!);
      index += 1;
    }
    blocks.push({ type: 'paragraph', segments: inlineSegments(paragraphLines.join(' ')) });
  }

  return blocks;
}

function startsParagraphContinuation(line: string): boolean {
  const isBlank = line.trim() === '';
  const startsAnotherBlock =
    line.startsWith(FENCE) || HEADING.test(line) || LIST_ITEM.test(line) || NOTE_BLOCK_START.test(line) || MENTION_LINE.test(line);
  return !isBlank && !startsAnotherBlock;
}

function findLine(lines: string[], from: number, matches: (line: string) => boolean): number {
  for (let index = from; index < lines.length; index += 1) {
    if (matches(lines[index]!)) return index;
  }
  return -1;
}

function inlineSegments(text: string): InlineSegment[] {
  return text
    .split('`')
    .map((part, position) => ({ text: part, isCode: position % 2 === 1 }))
    .filter((segment) => segment.text !== '');
}
