import { closeSync, constants, existsSync, fstatSync, openSync, renameSync, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { assertNoSymlink, KnowledgeImportError, type KnowledgeRejectionReason } from './knowledgeExportSchema.js';
import type { KnowledgeAuthority } from '../../knowledge/knowledgeTypes.js';

export interface KnowledgeCounts {
  source_rows: number;
  source_active: number;
  source_retired: number;
  inserted: number;
  updated: number;
  unchanged: number;
  conflicts: number;
  rejected: number;
  missing_source: number;
  missing_target: number;
}

export interface KnowledgeImportReport extends KnowledgeCounts {
  success: boolean;
  dry_run: boolean;
  committed: boolean;
  schema_upgraded: boolean;
  reason: KnowledgeRejectionReason | null;
  repositories: (KnowledgeCounts & { repository: number; authority: KnowledgeAuthority })[];
}

export const emptyKnowledgeCounts = (): KnowledgeCounts => ({ source_rows: 0, source_active: 0, source_retired: 0, inserted: 0, updated: 0, unchanged: 0, conflicts: 0, rejected: 0, missing_source: 0, missing_target: 0 });

export function rejectedKnowledgeReport(input: { reason: KnowledgeRejectionReason; dryRun: boolean }): KnowledgeImportReport {
  return { ...emptyKnowledgeCounts(), success: false, dry_run: input.dryRun, committed: false, schema_upgraded: false, rejected: 1, reason: input.reason, repositories: [] };
}

export const renderKnowledgeReport = (report: KnowledgeImportReport): string => `${JSON.stringify(report)}\n`;

export function assertReportTarget(path: string): void {
  try { assertNoSymlink(path); }
  catch (error) {
    if (error instanceof KnowledgeImportError) throw error;
    throw new KnowledgeImportError('REPORT_WRITE_FAILED');
  }
}

function assertUnprotectedDescriptor(input: { opened: Stats; protectedPaths: string[] }): void {
  if (!input.opened.isFile()) throw new KnowledgeImportError('REPORT_WRITE_FAILED');
  for (const path of input.protectedPaths) {
    if (!existsSync(path)) continue;
    const protectedFile = statSync(path);
    const aliasesProtectedFile = protectedFile.dev === input.opened.dev && protectedFile.ino === input.opened.ino;
    if (aliasesProtectedFile) throw new KnowledgeImportError('REPORT_WRITE_FAILED');
  }
}

function assertSameDirectory(input: { expected: Stats; directory: string }): void {
  const current = statSync(input.directory);
  const isSameDirectory = current.isDirectory() && current.dev === input.expected.dev && current.ino === input.expected.ino;
  if (!isSameDirectory) throw new KnowledgeImportError('REPORT_WRITE_FAILED');
}

/** Publishes the report as a new exclusively created file renamed into place; an existing inode is never opened for writing. */
export function persistKnowledgeReport(input: { path: string; report: KnowledgeImportReport; protectedPaths: string[] }): void {
  let descriptor: number | undefined;
  let temporaryPath: string | undefined;
  try {
    assertReportTarget(input.path);
    const directory = dirname(input.path);
    const validatedDirectory = statSync(directory);
    const candidatePath = join(directory, `${basename(input.path)}.${randomUUID()}.tmp`);
    descriptor = openSync(candidatePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    temporaryPath = candidatePath;
    assertUnprotectedDescriptor({ opened: fstatSync(descriptor), protectedPaths: input.protectedPaths });
    writeFileSync(descriptor, renderKnowledgeReport(input.report));
    closeSync(descriptor);
    descriptor = undefined;
    assertSameDirectory({ expected: validatedDirectory, directory });
    renameSync(temporaryPath, input.path);
    temporaryPath = undefined;
  } catch { throw new KnowledgeImportError('REPORT_WRITE_FAILED'); }
  finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporaryPath !== undefined) unlinkSync(temporaryPath);
  }
}
