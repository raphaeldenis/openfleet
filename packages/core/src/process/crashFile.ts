import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DaemonIssue } from '@openfleet/shared';
import { DAEMON_VERSION } from '../version.js';

export const CRASH_FILES_KEPT = 5;
export const MAX_CRASH_FILE_BYTES = 1024 * 1024;

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

/** The document names the daemon state and carries the newest log lines that fit the size cap; it holds nothing the logger did not redact. */
function documentWithinCap(input: CrashFileInput, generatedAt: string): string {
  let lines = input.logLines.map(parsedOrText);
  const serialized = () => JSON.stringify({
    generatedAt, reason: input.reason, ref: input.ref,
    version: { openfleet: DAEMON_VERSION, node: process.version, platform: process.platform },
    health: { status: input.issues.length === 0 ? 'ok' : 'degraded', issues: input.issues },
    log: lines,
  }, null, 1);
  let document = serialized();
  while (Buffer.byteLength(document) > MAX_CRASH_FILE_BYTES && lines.length > 0) {
    lines = lines.slice(Math.ceil(lines.length / 10));
    document = serialized();
  }
  return document;
}

function keepNewestFiles(dir: string): void {
  const crashFiles = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  for (const name of crashFiles.slice(0, -CRASH_FILES_KEPT)) {
    try { unlinkSync(join(dir, name)); } catch { /* an eviction that fails is retried by the next crash */ }
  }
}

/** Writes one owner-only json file per crash, synchronously because the process may be about to exit, then evicts all but the newest five. Throws when the file cannot be written. */
export function writeCrashFile(input: CrashFileInput): string {
  const generatedAt = new Date((input.now ?? Date.now)()).toISOString();
  mkdirSync(input.dir, { recursive: true, mode: 0o700 });
  const path = join(input.dir, `${generatedAt.replace(/:/g, '-')}-${input.ref}.json`);
  writeFileSync(path, documentWithinCap(input, generatedAt), { mode: 0o600, flag: 'wx' });
  keepNewestFiles(input.dir);
  return path;
}
