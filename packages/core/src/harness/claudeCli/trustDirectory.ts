import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fchmodSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { OpenFleetError } from '@openfleet/shared';

interface ClaudeConfig { projects?: Record<string, { hasTrustDialogAccepted?: boolean } & Record<string, unknown>> }

interface ConfigSnapshot {
  text: string | undefined;
  fingerprint: string | undefined;
  mode: number;
}

const NEW_FILE_MODE = 0o600;
const DEFAULT_INDENT = 2;
export const TRUST_WRITE_MAX_ATTEMPTS = 5;
const RETRY_JITTER_MAX_MS = 25;

/**
 * Marks `directory` as trusted in the Claude CLI config file. Synchronous end to end, so two callers in
 * this process never interleave between the read and the rename; a writer in another process is detected by
 * comparing the file's content fingerprint just before the rename, and the update is redone on top of its write.
 */
export function markDirectoryTrusted(configPath: string, directory: string): void {
  const realDirectory = existsSync(directory) ? realpathSync(directory) : directory;
  const targetPath = existsSync(configPath) ? realpathSync(configPath) : configPath;

  for (let attempt = 1; attempt <= TRUST_WRITE_MAX_ATTEMPTS; attempt += 1) {
    const snapshot = readSnapshot(targetPath);
    const config = parseConfig(snapshot.text);
    if (config.projects?.[realDirectory]?.hasTrustDialogAccepted) return;

    config.projects ??= {};
    config.projects[realDirectory] = { ...config.projects[realDirectory], hasTrustDialogAccepted: true };

    const wasReplaced = replaceFileUnlessChanged(targetPath, serialize(config, snapshot.text), snapshot);
    if (wasReplaced) return;
    sleepWithJitter();
  }
  throw new OpenFleetError('launch_failed', 'the Claude trust config kept changing while it was being updated.');
}

function readSnapshot(path: string): ConfigSnapshot {
  if (!existsSync(path)) return { text: undefined, fingerprint: undefined, mode: NEW_FILE_MODE };
  const bytes = readFileSync(path);
  return { text: bytes.toString('utf8'), fingerprint: fingerprintOf(bytes), mode: statSync(path).mode & 0o777 };
}

function currentFingerprint(path: string): string | undefined {
  return existsSync(path) ? fingerprintOf(readFileSync(path)) : undefined;
}

const fingerprintOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function parseConfig(text: string | undefined): ClaudeConfig {
  if (text === undefined) return {};
  const parsed = parseJsonOrUndefined(text);
  const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  if (!isObject) throw new OpenFleetError('launch_failed', 'the Claude trust config is not a valid JSON object.');
  return parsed as ClaudeConfig;
}

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function serialize(config: ClaudeConfig, originalText: string | undefined): string {
  const indent = originalText === undefined ? DEFAULT_INDENT : indentOf(originalText);
  const trailingNewline = originalText?.endsWith('\n') ? '\n' : '';
  return JSON.stringify(config, null, indent) + trailingNewline;
}

function indentOf(text: string): string | number {
  const firstIndent = /^\s*\{\r?\n([ \t]+)\S/.exec(text)?.[1];
  const isCompact = !text.includes('\n');
  if (firstIndent) return firstIndent;
  return isCompact ? 0 : DEFAULT_INDENT;
}

/** Writes through an exclusive 0600-style temp file in the target's folder, then renames it over the target. False when the target changed since `snapshot`. */
function replaceFileUnlessChanged(targetPath: string, content: string, snapshot: ConfigSnapshot): boolean {
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    writeExclusiveFile(tempPath, content, snapshot.mode);
    const hasChangedSinceRead = currentFingerprint(targetPath) !== snapshot.fingerprint;
    if (hasChangedSinceRead) {
      unlinkSync(tempPath);
      return false;
    }
    renameSync(tempPath, targetPath);
    return true;
  } catch (err) {
    removeQuietly(tempPath);
    throw err;
  }
}

function writeExclusiveFile(path: string, content: string, mode: number): void {
  const fd = openSync(path, 'wx', NEW_FILE_MODE);
  try {
    fchmodSync(fd, mode);
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone: nothing left to clean
  }
}

function sleepWithJitter(): void {
  const milliseconds = 1 + Math.floor(Math.random() * RETRY_JITTER_MAX_MS);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
