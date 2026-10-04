import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkingStateSections } from '@openfleet/shared';
import type { PlannedManager } from './scapeManagers.js';
import { parseWorkingStateFile } from './scapeWorkingStateFile.js';

const STATE_FILE_EXTENSION = '.md';
const MAX_STATE_FILE_CHARACTERS = 256 * 1024;
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

function stateFileNamesIn(stateDir: string): string[] {
  try {
    return readdirSync(stateDir).filter((fileName) => fileName.endsWith(STATE_FILE_EXTENSION));
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

/** Reads a state file of the folder when it is a regular file (a link or a folder is not followed); nothing outside the folder is ever opened. */
function readStateFile(stateDir: string, fileName: string): { text: string; modifiedAt: string; isTooLong: boolean } | undefined {
  const path = join(stateDir, fileName);
  try {
    const stats = lstatSync(path);
    if (!stats.isFile()) return undefined;
    const fullText = readFileSync(path, 'utf8');
    const isTooLong = fullText.length > MAX_STATE_FILE_CHARACTERS;
    return { text: fullText.slice(0, MAX_STATE_FILE_CHARACTERS), modifiedAt: stats.mtime.toISOString(), isTooLong };
  } catch {
    return undefined;
  }
}

/** Plans the working state of each manager whose state file exists in the folder; a manager without a file gets none. */
export function planWorkingStates(input: { stateDir: string | undefined; managers: PlannedManager[] }): PlannedWorkingState[] {
  const { stateDir } = input;
  if (stateDir === undefined) return [];
  const fileNames = stateFileNamesIn(stateDir);
  const planned: PlannedWorkingState[] = [];
  for (const manager of input.managers) {
    const fileName = stateFileNameOf(stateFileStemOf(manager.session.name), fileNames);
    const file = fileName === undefined ? undefined : readStateFile(stateDir, fileName);
    if (file === undefined) continue;
    const parsed = parseWorkingStateFile(file.text);
    planned.push({
      managerId: manager.id, sections: parsed.sections, updatedAt: file.modifiedAt,
      mergedSectionCount: parsed.mergedSectionCount, isNotFullyConverted: parsed.isNotFullyConverted || file.isTooLong,
    });
  }
  return planned;
}
