import { readdirSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { WorkingStateSections } from '@openfleet/shared';
import { readUtf8Prefix } from './boundedUtf8File.js';
import type { PlannedManager } from './scapeManagers.js';
import { resolveStateFolder } from './scapeStateFolder.js';
import { parseWorkingStateFile } from './scapeWorkingStateFile.js';

const STATE_FILE_EXTENSION = '.md';
const MAX_STATE_FILE_BYTES = 256 * 1024;
const NOT_A_FILE_NAME_CHARACTER = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;

export interface PlannedWorkingState {
  managerId: string;
  sections: WorkingStateSections;
  /** The modification time of the state file: the moment the state was last true in Scape. */
  updatedAt: string;
  mergedSectionCount: number;
  isNotFullyConverted: boolean;
}

/** The file name stem of a manager: its name in lower case with every run of other characters as one dash ("Lead (CCM)" is "lead-ccm"). */
export const stateFileStemOf = (managerName: string): string => managerName.toLowerCase().replace(NOT_A_FILE_NAME_CHARACTER, '-').replace(EDGE_DASHES, '');

function stateFileNamesIn(folder: string): string[] {
  try {
    return readdirSync(folder).filter((fileName) => fileName.endsWith(STATE_FILE_EXTENSION));
  } catch {
    return [];
  }
}

/** The file named exactly after the manager, else the only file whose name starts with the manager's followed by a dash; two candidates are no match. */
function stateFileNameOf(stem: string, fileNames: string[]): string | undefined {
  if (stem === '') return undefined;
  const exactName = `${stem}${STATE_FILE_EXTENSION}`;
  if (fileNames.includes(exactName)) return exactName;
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
}

/** Plans the working state of each manager whose state file exists in the folder; a manager without a file gets none. A folder reached through a link is refused. */
export function planWorkingStates(input: PlanWorkingStatesInput): PlannedWorkingState[] {
  if (input.stateDir === undefined) return [];
  const folder = resolveStateFolder({ stateDir: input.stateDir, stateRoot: input.stateRoot });
  if (folder === undefined) return [];

  const fileNames = stateFileNamesIn(folder);
  const planned: PlannedWorkingState[] = [];
  for (const manager of input.managers) {
    const fileName = stateFileNameOf(stateFileStemOf(manager.session.name), fileNames);
    const file = fileName === undefined ? undefined : readStateFile(folder, fileName);
    if (file === undefined) continue;
    const parsed = parseWorkingStateFile(file.text);
    planned.push({
      managerId: manager.id, sections: parsed.sections, updatedAt: file.modifiedAt,
      mergedSectionCount: parsed.mergedSectionCount, isNotFullyConverted: parsed.isNotFullyConverted || file.isTruncated,
    });
  }
  return planned;
}
