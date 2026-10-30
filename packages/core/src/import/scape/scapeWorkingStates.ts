import { readdirSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { WorkingStateSections } from '@openfleet/shared';
import { readUtf8Prefix } from './boundedUtf8File.js';
import type { PlannedManager } from './scapeManagers.js';
import { resolveStateFolder } from './scapeStateFolder.js';
import { parseWorkingStateFile } from './scapeWorkingStateFile.js';
import { withoutAccents } from './withoutAccents.js';

const STATE_FILE_EXTENSION = '.md';
const MAX_STATE_FILE_BYTES = 256 * 1024;
const NOT_A_FILE_NAME_CHARACTER = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;

export interface PlannedWorkingState {
  managerId: string;
  managerName: string;
  sections: WorkingStateSections;
  /** The modification time of the state file: the moment the state was last true in Scape. */
  updatedAt: string;
  mergedSectionCount: number;
  isNotFullyConverted: boolean;
}

const dashedStemOf = (text: string): string => text.toLowerCase().replace(NOT_A_FILE_NAME_CHARACTER, '-').replace(EDGE_DASHES, '');

/** The file name stem of a manager: its name unaccented, in lower case, with every run of other characters as one dash ("Lead (CCM)" is "lead-ccm", "Mnémosyne" is "mnemosyne"). */
export const stateFileStemOf = (managerName: string): string => dashedStemOf(withoutAccents(managerName));

/** The stem with each accented letter as a dash ("Mnémosyne" is "mn-mosyne"), as Scape state files may still be named. */
const formerStateFileStemOf = (managerName: string): string => dashedStemOf(managerName);

const exactStateFileNameOf = (stem: string, fileNames: string[]): string | undefined => {
  const exactName = `${stem}${STATE_FILE_EXTENSION}`;
  return stem !== '' && fileNames.includes(exactName) ? exactName : undefined;
};

interface StemsOfAllManagers { current: string[]; former: string[] }

/**
 * The file named exactly after the former stem, unless the former stem is the current one, the current stem of another Scape manager
 * (imported or not), or the former stem of another Scape manager.
 */
function formerStateFileNameOf(input: { managerName: string; fileNames: string[]; stemsOfAllManagers: StemsOfAllManagers }): string | undefined {
  const currentStem = stateFileStemOf(input.managerName);
  const formerStem = formerStateFileStemOf(input.managerName);
  const isFormerStemTheCurrentOne = formerStem === currentStem;
  const isFormerStemAnotherManagersCurrentStem = input.stemsOfAllManagers.current.includes(formerStem);
  const isFormerStemSharedByManagers = input.stemsOfAllManagers.former.filter((stem) => stem === formerStem).length > 1;
  if (isFormerStemTheCurrentOne || isFormerStemAnotherManagersCurrentStem || isFormerStemSharedByManagers) return undefined;
  return exactStateFileNameOf(formerStem, input.fileNames);
}

function stateFileNamesIn(folder: string): string[] {
  try {
    return readdirSync(folder).filter((fileName) => fileName.endsWith(STATE_FILE_EXTENSION));
  } catch {
    return [];
  }
}

/** The file named exactly after the manager, else the only file whose name starts with the manager's followed by a dash; two candidates are no match. */
function stateFileNameOf(stem: string, fileNames: string[]): string | undefined {
  const exactName = exactStateFileNameOf(stem, fileNames);
  if (exactName !== undefined || stem === '') return exactName;
  const longerNames = fileNames.filter((fileName) => fileName.startsWith(`${stem}-`));
  return longerNames.length === 1 ? longerNames[0] : undefined;
}

/** Reads the first bytes of a regular file of the folder (a link is refused when it is opened); a path that does not resolve inside the folder is never read. */
function readStateFile(folder: string, fileName: string) {
  const path = join(folder, fileName);
  try {
    const isInsideFolder = realpathSync(path).startsWith(`${folder}${sep}`);
    return isInsideFolder ? readUtf8Prefix({ path, maxBytes: MAX_STATE_FILE_BYTES }) : undefined;
  } catch {
    return undefined;
  }
}

export interface PlanWorkingStatesInput {
  stateDir: string | undefined;
  stateRoot: string | undefined;
  managers: PlannedManager[];
  /** The name of every Scape manager read, whether the import keeps it or not. */
  allManagerNames: string[];
}

/** Plans the working state of each manager whose state file exists in the folder; a manager without a file gets none. A folder reached through a link is refused. */
export function planWorkingStates(input: PlanWorkingStatesInput): PlannedWorkingState[] {
  if (input.stateDir === undefined) return [];
  const folder = resolveStateFolder({ stateDir: input.stateDir, stateRoot: input.stateRoot });
  if (folder === undefined) return [];

  const fileNames = stateFileNamesIn(folder);
  const stemsOfAllManagers: StemsOfAllManagers = { current: input.allManagerNames.map(stateFileStemOf), former: input.allManagerNames.map(formerStateFileStemOf) };
  const planned: PlannedWorkingState[] = [];
  for (const manager of input.managers) {
    const fileName = stateFileNameOf(stateFileStemOf(manager.session.name), fileNames) ?? formerStateFileNameOf({ managerName: manager.session.name, fileNames, stemsOfAllManagers });
    const file = fileName === undefined ? undefined : readStateFile(folder, fileName);
    if (file === undefined) continue;
    const parsed = parseWorkingStateFile(file.text);
    planned.push({
      managerId: manager.id, managerName: manager.session.name, sections: parsed.sections, updatedAt: file.modifiedAt,
      mergedSectionCount: parsed.mergedSectionCount, isNotFullyConverted: parsed.isNotFullyConverted || file.isTruncated,
    });
  }
  return planned;
}
