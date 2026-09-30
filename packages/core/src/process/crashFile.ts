import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DaemonIssue } from '@openfleet/shared';
import { DAEMON_VERSION } from '../version.js';

/** The folder of the daemon home that holds the crash files. */
export const CRASH_FOLDER_NAME = 'crashes';
export const CRASH_FILES_KEPT = 5;
export const MAX_CRASH_FILE_BYTES = 1024 * 1024;
/** Room for the document around the log: its keys, the version, the issues. */
const DOCUMENT_OVERHEAD_BYTES = 8 * 1024;
const CRASH_FILE_NAME = /^\d{4}-\d\d-\d\dT[\d-]+\.\d{3}Z-[0-9a-f]{8}\.json$/;

export type CrashReason = 'uncaught_exception' | 'unhandled_rejection';

export interface CrashFileInput {
  dir: string;
  reason: CrashReason;
  /** The ref of the crash: the id of its log line and of its issue. */
  ref: string;
  issues: DaemonIssue[];
  /** The recent log lines, already redacted by the logger. */
  logLines: string[];
  now?: () => number;
}

const parsedOrText = (line: string): unknown => {
  try { return JSON.parse(line); } catch { return line; }
};

/** The newest log lines whose serialized sizes fit the budget, found in one pass from the newest line back. */
function newestLinesWithin(logLines: string[], budgetBytes: number): unknown[] {
  const kept: unknown[] = [];
  let usedBytes = 0;
  for (let index = logLines.length - 1; index >= 0; index -= 1) {
    const line = parsedOrText(logLines[index]!);
    usedBytes += Buffer.byteLength(JSON.stringify(line)) + 1;
    if (usedBytes > budgetBytes) break;
    kept.push(line);
  }
  return kept.reverse();
}

function documentWithinCap(input: CrashFileInput, generatedAt: string): string {
  return JSON.stringify({
    generatedAt, reason: input.reason, ref: input.ref,
    version: { openfleet: DAEMON_VERSION, node: process.version, platform: process.platform },
    health: { status: input.issues.length === 0 ? 'ok' : 'degraded', issues: input.issues },
    log: newestLinesWithin(input.logLines, MAX_CRASH_FILE_BYTES - DOCUMENT_OVERHEAD_BYTES),
  });
}

/** Keeps the newest crash files by modification time; a file that does not match the crash file name is neither counted nor touched, and the file just written stays. */
function keepNewestFiles(dir: string, justWritten: string): void {
  const modifiedAt = (name: string): number => { try { return statSync(join(dir, name)).mtimeMs; } catch { return 0; } };
  const olderFirst = readdirSync(dir)
    .filter((name) => CRASH_FILE_NAME.test(name) && name !== justWritten)
    .map((name) => ({ name, modifiedAt: modifiedAt(name) }))
    .sort((left, right) => left.modifiedAt - right.modifiedAt || left.name.localeCompare(right.name));
  for (const { name } of olderFirst.slice(0, Math.max(0, olderFirst.length - (CRASH_FILES_KEPT - 1)))) {
    try { unlinkSync(join(dir, name)); } catch { /* an eviction that fails is retried by the next crash */ }
  }
}

/** Writes one owner-only json file per crash, synchronously because the process may be about to exit, through a temporary name so a partial write never shows; then evicts all but the newest five. Throws when the file cannot be written. */
export function writeCrashFile(input: CrashFileInput): string {
  const generatedAt = new Date((input.now ?? Date.now)()).toISOString();
  mkdirSync(input.dir, { recursive: true, mode: 0o700 });
  const name = `${generatedAt.replace(/:/g, '-')}-${input.ref}.json`;
  const path = join(input.dir, name);
  const temporaryPath = join(input.dir, `.${name}.tmp`);
  try {
    writeFileSync(temporaryPath, documentWithinCap(input, generatedAt), { mode: 0o600, flag: 'wx' });
    renameSync(temporaryPath, path);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* nothing was created */ }
    throw error;
  }
  keepNewestFiles(input.dir, name);
  return path;
}
