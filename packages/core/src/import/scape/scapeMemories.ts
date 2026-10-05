import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { claudeMemoryFolderOf } from './claudeProjectDirectory.js';
import type { PlannedManager } from './scapeManagers.js';

export const MAX_MEMORY_FILE_BYTES = 256 * 1024;
export const MAX_MEMORY_BYTES_PER_MANAGER = 2 * 1024 * 1024;

const MEMORY_FILE_EXTENSION = '.md';

export interface PlannedMemoryFile {
  name: string;
  /** Absent when the file is refused: a link, or over a size cap. */
  copy?: { content: Buffer; sha256: string };
}

export interface PlannedMemory {
  managerId: string;
  sourceFolder: string;
  /** The Scape side memory folder was a link: nothing in it is read. */
  isFolderRefused: boolean;
  files: PlannedMemoryFile[];
}

export interface MemorySource {
  scapeDir: string;
  /** The Claude config folder that holds the memory of the Scape managers. */
  scapeClaudeDir: string;
}

export const memoryFileIdOf = (input: { managerId: string; fileName: string }) => `${input.managerId}/${input.fileName}`;

const isMemoryFileName = (entry: Dirent) => entry.name.endsWith(MEMORY_FILE_EXTENSION) && (entry.isFile() || entry.isSymbolicLink());

function planFiles(memoryFolder: string): PlannedMemoryFile[] {
  const entries = readdirSync(memoryFolder, { withFileTypes: true }).filter(isMemoryFileName).sort((a, b) => (a.name < b.name ? -1 : 1));
  let copiedBytes = 0;
  return entries.map((entry) => {
    const path = join(memoryFolder, entry.name);
    const size = lstatSync(path).size;
    const isRefused = entry.isSymbolicLink() || size > MAX_MEMORY_FILE_BYTES || copiedBytes + size > MAX_MEMORY_BYTES_PER_MANAGER;
    if (isRefused) return { name: entry.name };
    const content = readFileSync(path);
    copiedBytes += content.length;
    return { name: entry.name, copy: { content, sha256: createHash('sha256').update(content).digest('hex') } };
  });
}

function planMemoryOf(manager: PlannedManager, source: MemorySource): PlannedMemory | undefined {
  const scapeWorkingDirectory = join(source.scapeDir, 'argus', manager.id);
  const memoryFolder = claudeMemoryFolderOf({ claudeDir: source.scapeClaudeDir, workingDirectory: scapeWorkingDirectory });
  const folder = lstatSync(memoryFolder, { throwIfNoEntry: false });
  if (folder === undefined) return undefined;
  const isFolderRefused = !folder.isDirectory();
  return { managerId: manager.id, sourceFolder: memoryFolder, isFolderRefused, files: isFolderRefused ? [] : planFiles(memoryFolder) };
}

/** What each manager's Scape side Claude memory holds: its regular markdown files, read under the size caps. Reads only. */
export function planMemories(input: { managers: PlannedManager[]; source: MemorySource }): PlannedMemory[] {
  return input.managers.flatMap((manager) => planMemoryOf(manager, input.source) ?? []);
}
