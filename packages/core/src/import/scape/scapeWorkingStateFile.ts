import { WORKING_STATE_MAX_ITEMS_PER_SECTION, WORKING_STATE_MAX_ITEM_CHARACTERS, WORKING_STATE_SECTIONS, type WorkingStateSectionKey, type WorkingStateSections } from '@openfleet/shared';
import { renderWorkingState } from '../../workingState/renderWorkingState.js';
import { DEFAULT_WORKING_STATE_MAX_BYTES } from '../../workingState/workingStateSettings.js';

const SECTION_OF_HEADING = new Map<string, WorkingStateSectionKey>([
  ['plan', 'plan'],
  ['todo', 'todo'],
  ['reste à faire', 'remaining'],
  ['questions pour raphaël', 'questionsForHuman'],
  ["questions pour l'humain", 'questionsForHuman'],
  ['questions internes', 'internalQuestions'],
  ['blocages', 'blockers'],
]);
const SECTION_RECEIVING_FOLDED_HEADING = new Map<string, WorkingStateSectionKey>([
  ['ordres permanents', 'plan'],
  ['décisions raphaël', 'plan'],
  ['main et pr', 'remaining'],
  ['enfants vivants', 'remaining'],
]);
const UNTITLED_HEADING = 'untitled';
const TITLE_LINE = /^#\s/;
const SECTION_RECEIVING_ANY_OTHER_HEADING: WorkingStateSectionKey = 'plan';

const HEADING_LINE = /^#{2,}\s+(.*)$/;
const TRAILING_PARENTHESIS = /\s*\(.*\)\s*$/;
const BULLET_PREFIX = /^\s*(?:[-*+]|\d+[.)])\s+/;
const LEADING_HASHES = /^#+\s*/;
// The code points the working state refuses in an item: controls except tab, line and paragraph separators, bidirectional embeddings, overrides and isolates.
const REFUSED_CODE_POINT_RANGES: readonly (readonly [first: number, last: number])[] = [
  [0x00, 0x08], [0x0a, 0x1f], [0x7f, 0x7f], [0x85, 0x85], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069],
];
const isRefusedCodePoint = (codePoint: number) => REFUSED_CODE_POINT_RANGES.some(([first, last]) => codePoint >= first && codePoint <= last);
const withRefusedCharactersAsSpaces = (text: string) => Array.from(text, (character) => (isRefusedCodePoint(character.codePointAt(0)!) ? ' ' : character)).join('');
const EMPTY_SECTION_PLACEHOLDER = '(rien)';
const ELLIPSIS = '…';

export interface ParsedWorkingState {
  sections: WorkingStateSections;
  /** Sections of the file that are not working state sections and were folded into one, under a line carrying their heading. */
  mergedSectionCount: number;
  /** An item was cut, an item was dropped for the item limit or for the size cap. */
  isNotFullyConverted: boolean;
}

const emptySections = (): WorkingStateSections => ({ plan: [], todo: [], remaining: [], questionsForHuman: [], internalQuestions: [], blockers: [] });

const sizeInBytes = (sections: WorkingStateSections) => Buffer.byteLength(renderWorkingState(sections), 'utf8');

const headingTextOf = (line: string): string | undefined => {
  const heading = HEADING_LINE.exec(line)?.[1];
  if (heading === undefined) return undefined;
  const withoutParenthesis = heading.replace(TRAILING_PARENTHESIS, '').trim().replace(LEADING_HASHES, '');
  return withRefusedCharactersAsSpaces(withoutParenthesis).trim() || UNTITLED_HEADING;
};

const isStrayText = (line: string) => line.trim() !== '' && !TITLE_LINE.test(line);

function itemTextOf(line: string): string {
  return withRefusedCharactersAsSpaces(line.replace(BULLET_PREFIX, '').trim().replace(LEADING_HASHES, '')).trim();
}

function cutToItemLimit(item: string): string {
  const characters = Array.from(item);
  const isTooLong = characters.length > WORKING_STATE_MAX_ITEM_CHARACTERS;
  return isTooLong ? `${characters.slice(0, WORKING_STATE_MAX_ITEM_CHARACTERS - 1).join('')}${ELLIPSIS}` : item;
}

const itemBytes = (item: string) => Buffer.byteLength(item, 'utf8');

function largestSectionOf(sections: WorkingStateSections): WorkingStateSectionKey {
  const bytesOf = (key: WorkingStateSectionKey) => sections[key].reduce((total, item) => total + itemBytes(item), 0);
  return WORKING_STATE_SECTIONS.reduce((largest, key) => (bytesOf(key) > bytesOf(largest) ? key : largest));
}

/** Reads a Scape `state/<manager>.md` file into the six working state sections; what does not fit the model is cut or dropped, never silently. */
export function parseWorkingStateFile(text: string): ParsedWorkingState {
  const sections = emptySections();
  let target: WorkingStateSectionKey | undefined;
  let mergedSectionCount = 0;
  let isNotFullyConverted = false;

  for (const line of text.split('\n')) {
    const heading = headingTextOf(line);
    const isHeading = heading !== undefined;
    if (isHeading) {
      const ownSection = SECTION_OF_HEADING.get(heading.toLowerCase());
      target = ownSection ?? SECTION_RECEIVING_FOLDED_HEADING.get(heading.toLowerCase()) ?? SECTION_RECEIVING_ANY_OTHER_HEADING;
      if (ownSection === undefined) {
        sections[target].push(`[${heading}]`);
        mergedSectionCount++;
      }
      continue;
    }
    if (target === undefined) {
      isNotFullyConverted ||= isStrayText(line);
      continue;
    }
    const item = itemTextOf(line);
    const isNoItem = item === '' || item === EMPTY_SECTION_PLACEHOLDER;
    if (!isNoItem) sections[target].push(item);
  }

  for (const key of WORKING_STATE_SECTIONS) {
    const cutItems = sections[key].map(cutToItemLimit);
    const hasCutItem = cutItems.some((item, index) => item !== sections[key][index]);
    const hasTooManyItems = cutItems.length > WORKING_STATE_MAX_ITEMS_PER_SECTION;
    isNotFullyConverted ||= hasCutItem || hasTooManyItems;
    sections[key] = cutItems.slice(0, WORKING_STATE_MAX_ITEMS_PER_SECTION);
  }

  while (sizeInBytes(sections) > DEFAULT_WORKING_STATE_MAX_BYTES) {
    sections[largestSectionOf(sections)].pop();
    isNotFullyConverted = true;
  }
  return { sections, mergedSectionCount, isNotFullyConverted };
}
