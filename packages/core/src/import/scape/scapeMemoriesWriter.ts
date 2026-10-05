import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { claudeMemoryFolderOf, claudeProjectFolderNameOf, MAX_CLAUDE_PROJECT_FOLDER_NAME_LENGTH } from './claudeProjectDirectory.js';
import { countOutcome, type ImportReport } from './importReport.js';
import { ImportLedger } from './scapeLedger.js';
import { memoryFileIdOf, MAX_MEMORY_FILE_BYTES, type PlannedMemory, type PlannedMemoryFile } from './scapeMemories.js';
import type { ImportPlan } from './scapePlan.js';
import { ScapeImportError } from './scapeImportError.js';
import { reconcileRecord, type RecordGateway, type UpsertOutcome } from './scapeTarget.js';

const PRIVATE_FOLDER_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const UNREADABLE_OVERSIZED_FILE = 'oversized';
const MANAGER_OUTCOMES_THAT_OWN_THEIR_MEMORY: UpsertOutcome[] = ['written', 'updated', 'alreadyPresent'];

const refuse = (message: string) => new ScapeImportError({ code: 'IMPORT_WRITE_FAILED', message });

export interface MemoryWriteContext {
  claudeDir: string;
  dryRun: boolean;
  journal: MemoryFilesJournal;
}

/** What a run did on disk, so that a failed run can undo exactly that: created files and folders are removed, overwritten files restored. */
export class MemoryFilesJournal {
  private readonly createdFiles: string[] = [];
  private readonly createdFolders: string[] = [];
  private readonly overwrittenFiles: { path: string; content: Buffer }[] = [];

  createFolders(folder: string): void {
    const missing: string[] = [];
    for (let current = folder; lstatSync(current, { throwIfNoEntry: false }) === undefined; current = dirname(current)) missing.unshift(current);
    for (const missingFolder of missing) {
      mkdirSync(missingFolder, { mode: PRIVATE_FOLDER_MODE });
      this.createdFolders.push(missingFolder);
    }
  }

  createFile(input: { path: string; content: Buffer }): void {
    writeFileSync(input.path, input.content, { flag: 'wx', mode: PRIVATE_FILE_MODE });
    this.createdFiles.push(input.path);
  }

  overwriteFile(input: { path: string; content: Buffer }): void {
    this.overwrittenFiles.push({ path: input.path, content: readFileSync(input.path) });
    writeFileSync(input.path, input.content);
  }

  rollback(): void {
    this.overwrittenFiles.forEach(({ path, content }) => writeFileSync(path, content));
    this.createdFiles.forEach((path) => unlinkSync(path));
    [...this.createdFolders].reverse().forEach((folder) => { try { rmdirSync(folder); } catch { /* not empty or already gone: left as it is */ } });
  }
}

const sha256Of = (content: Buffer) => createHash('sha256').update(content).digest('hex');

function assertNoLinkAlong(targetFolder: string): void {
  for (const folder of [dirname(targetFolder), targetFolder]) {
    const isLink = lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
    if (isLink) throw refuse(`${folder} is a link: Claude memory is not written through a link`);
  }
}

/** The folder is a manager's own: the session directory stored in the database wins over the planned one. */
function workingDirectoryOf(db: DatabaseSync, planned: PlannedManagerDirectory): string {
  const stored = db.prepare('SELECT directory FROM sessions WHERE id = ?').get(planned.managerId) as { directory: string } | undefined;
  return stored?.directory ?? planned.directory;
}

interface PlannedManagerDirectory { managerId: string; directory: string }

function targetGateway(input: { targetPath: string; file: PlannedMemoryFile; context: MemoryWriteContext }): RecordGateway {
  const { targetPath, file, context } = input;
  const { content } = file.copy!;
  return {
    readStored: () => {
      const stored = lstatSync(targetPath, { throwIfNoEntry: false });
      if (stored === undefined) return undefined;
      if (!stored.isFile()) throw refuse(`${targetPath} is not a regular file: Claude memory is not written through it`);
      return { sha256: stored.size > MAX_MEMORY_FILE_BYTES ? UNREADABLE_OVERSIZED_FILE : sha256Of(readFileSync(targetPath)) };
    },
    insert: () => {
      if (context.dryRun) return;
      context.journal.createFolders(dirname(targetPath));
      context.journal.createFile({ path: targetPath, content });
    },
    update: () => {
      if (context.dryRun) return;
      context.journal.overwriteFile({ path: targetPath, content });
    },
  };
}

function writeMemoryFiles(input: { ledger: ImportLedger; report: ImportReport; context: MemoryWriteContext; memory: PlannedMemory; workingDirectory: string; isManagerOurs: boolean }): void {
  const { ledger, report, context, memory, workingDirectory } = input;
  const counts = report.counts.memories;
  const targetFolder = claudeMemoryFolderOf({ claudeDir: context.claudeDir, workingDirectory });
  const isFolderNameHashedByClaude = claudeProjectFolderNameOf(workingDirectory).length > MAX_CLAUDE_PROJECT_FOLDER_NAME_LENGTH;
  if (resolve(targetFolder) === resolve(memory.sourceFolder)) throw refuse(`the memory folder of the manager ${memory.managerId} is its own source`);
  if (input.isManagerOurs && !isFolderNameHashedByClaude) assertNoLinkAlong(targetFolder);

  for (const file of memory.files) {
    counts.expected++;
    if (file.copy === undefined || isFolderNameHashedByClaude) { counts.notConverted++; if (!input.isManagerOurs) counts.conflict++; continue; }
    if (!input.isManagerOurs) { counts.conflict++; continue; }
    const outcome = reconcileRecord({
      ledger, kind: 'memory_file', id: memoryFileIdOf({ managerId: memory.managerId, fileName: file.name }), planned: { sha256: file.copy.sha256 }, policy: {},
      gateway: targetGateway({ targetPath: join(targetFolder, file.name), file, context }),
    });
    countOutcome(counts, outcome);
  }
}

/**
 * Copies the planned memory files into the Claude memory folder of each imported manager's working directory. A file OpenFleet moved on from
 * since the last import is a conflict and never replaced. The folders and files created are journaled; a dry run only reads.
 */
export function writeMemories(input: { db: DatabaseSync; plan: ImportPlan; report: ImportReport; managerOutcomes: Map<string, UpsertOutcome>; context: MemoryWriteContext }): void {
  const { db, plan, report, managerOutcomes, context } = input;
  const ledger = new ImportLedger(db);
  const managerById = new Map(plan.managers.map((manager) => [manager.id, manager]));
  for (const memory of plan.memories ?? []) {
    const manager = managerById.get(memory.managerId)!;
    if (memory.isFolderRefused) { report.counts.memories.expected++; report.counts.memories.notConverted++; continue; }
    const outcome = managerOutcomes.get(memory.managerId);
    const isManagerOurs = outcome !== undefined && MANAGER_OUTCOMES_THAT_OWN_THEIR_MEMORY.includes(outcome);
    const workingDirectory = workingDirectoryOf(db, { managerId: manager.id, directory: manager.session.directory });
    writeMemoryFiles({ ledger, report, context, memory, workingDirectory, isManagerOurs });
  }
}
