import { isLegacyMission } from '@openfleet/shared';
import { CHILDREN_COUNT_PHRASES, EXACT_MODEL_ID, HUMAN_QA_PHRASES } from '../../managers/managerContentPatterns.js';

const EXACT_MODEL_ID_WITH_VERSION = new RegExp(`${EXACT_MODEL_ID.source}[a-z0-9.-]*[a-z0-9]`, 'g');
const MARKDOWN_HEADING = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const FENCE_LINE = /^ {0,3}(```|~~~)/;
const HEADING_NUMBERING = /^[\d.§\s)-]+/;

/** Extra headings, besides the title of the section itself, that state what a base section states. */
const ALTERNATIVE_HEADINGS_BY_BASE_SECTION_ID: Record<string, RegExp[]> = {
  '§1': [/^order of precedence$/],
  '§2': [/^(the )?pulse( protocol| routine)?$/],
  '§3': [/^(journal|working state)$/],
  '§4': [/^(context reset|after (a )?(compaction|reset|clear))$/],
  '§5': [/^(child rules|children rules|personas?|spawning children)$/],
  '§6': [/^(models?|escalation( ladder)?)$/],
  '§7': [/^delivery pipeline$/],
  '§8': [/^findings gate$/],
  '§9': [/^(prohibitions|child rules|shell hygiene)$/],
};

export interface BaseSectionOutline { id: string; title: string }

export interface BaseSectionDuplicate { sectionId: string; heading: string }

export interface ManagerMissionReport {
  managerId: string;
  name: string;
  /** UTF-8 size of the mission. */
  bytes: number;
  isLegacyMission: boolean;
  /** The lines that write a number of children or a cap. */
  numberedChildrenCaps: string[];
  /** The exact model ids, each once, in order of appearance. */
  exactModelIds: string[];
  /** The lines that make the QA the job of the human. */
  humanQaPhrases: string[];
  /** The headings of the mission that repeat a section of the base. */
  baseSectionDuplicates: BaseSectionDuplicate[];
}

export interface ManagerMissionSubject { managerId: string; name: string; missionText: string }

const trimmedNonEmptyLines = (text: string) => text.split('\n').map((line) => line.trim()).filter((line) => line !== '');

function headingsOutsideCodeFences(text: string): string[] {
  let isInsideFence = false;
  const headings: string[] = [];
  for (const line of text.split('\n')) {
    if (FENCE_LINE.test(line)) { isInsideFence = !isInsideFence; continue; }
    const heading = isInsideFence ? undefined : MARKDOWN_HEADING.exec(line)?.[1];
    if (heading !== undefined) headings.push(heading);
  }
  return headings;
}

const comparableHeading = (heading: string) => heading.replace(HEADING_NUMBERING, '').trim().toLowerCase();

function baseSectionRepeatedBy(heading: string, baseSections: BaseSectionOutline[]): BaseSectionOutline | undefined {
  const comparable = comparableHeading(heading);
  return baseSections.find(({ id, title }) => {
    const isTitleOfSection = comparable === title.toLowerCase();
    const isAlternativeHeading = (ALTERNATIVE_HEADINGS_BY_BASE_SECTION_ID[id] ?? []).some((alternative) => alternative.test(comparable));
    return isTitleOfSection || isAlternativeHeading;
  });
}

function baseSectionDuplicatesOf(text: string, baseSections: BaseSectionOutline[]): BaseSectionDuplicate[] {
  return headingsOutsideCodeFences(text).flatMap((heading) => {
    const repeated = baseSectionRepeatedBy(heading, baseSections);
    return repeated === undefined ? [] : [{ sectionId: repeated.id, heading }];
  });
}

/** Describes what the mission of one manager holds that the shared base now owns; reads the text and rewrites nothing. */
export function reportManagerMission({ managerId, name, missionText }: ManagerMissionSubject, baseSections: BaseSectionOutline[]): ManagerMissionReport {
  const lines = trimmedNonEmptyLines(missionText);
  return {
    managerId,
    name,
    bytes: Buffer.byteLength(missionText, 'utf8'),
    isLegacyMission: isLegacyMission(missionText),
    numberedChildrenCaps: lines.filter((line) => CHILDREN_COUNT_PHRASES.some((phrase) => phrase.test(line))),
    exactModelIds: [...new Set(missionText.match(EXACT_MODEL_ID_WITH_VERSION) ?? [])],
    humanQaPhrases: lines.filter((line) => HUMAN_QA_PHRASES.test(line)),
    baseSectionDuplicates: baseSectionDuplicatesOf(missionText, baseSections),
  };
}
