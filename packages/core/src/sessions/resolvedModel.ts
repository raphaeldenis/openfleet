import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isValidModelId } from '@openfleet/shared';

export const TRANSCRIPT_TAIL_WINDOW_BYTES = 256 * 1024;

const NEWLINE_BYTE = 0x0a;
const CLI_VERSION_PATTERN = /^\d+\.\d+\.\d+[0-9A-Za-z.+-]{0,20}$/;

interface ResolvedModel { resolvedModel: string; cliVersion: string }

// Reads at most the last TRANSCRIPT_TAIL_WINDOW_BYTES of the file. A window that starts past byte 0 starts
// inside a line unless the byte just before it is a newline, so its first fragment is then dropped.
// A missing file, or anything that is not a regular file (a named pipe, a directory), is an empty tail;
// any other read error throws. The open never blocks on a named pipe without a writer.
export function readTranscriptTail(path: string): string {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) return '';
    const windowStart = Math.max(0, stats.size - TRANSCRIPT_TAIL_WINDOW_BYTES);
    const startsPastFileStart = windowStart > 0;
    const readStart = startsPastFileStart ? windowStart - 1 : windowStart;
    const buffer = Buffer.alloc(stats.size - readStart);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, readStart);
    const bytes = buffer.subarray(0, bytesRead);
    if (!startsPastFileStart) return bytes.toString('utf8');
    const firstLineBreak = bytes.indexOf(NEWLINE_BYTE);
    return firstLineBreak === -1 ? '' : bytes.subarray(firstLineBreak + 1).toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

// Total over hostile input: a line that is not JSON, not an object, or has an unexpected shape is skipped.
// Returns the earliest main-chain assistant line written at or after `launchedAt`.
export function findResolvedModel(tail: string, launchedAt: string): ResolvedModel | undefined {
  const launchedAtMs = Date.parse(launchedAt);
  for (const line of tail.split('\n')) {
    const resolution = resolutionOfLine(line, launchedAtMs);
    if (resolution) return resolution;
  }
  return undefined;
}

function resolutionOfLine(line: string, launchedAtMs: number): ResolvedModel | undefined {
  const entry = parseJsonObject(line);
  if (!entry) return undefined;
  const isMainChainAssistantLine = entry.type === 'assistant' && entry.isSidechain !== true;
  if (!isMainChainAssistantLine) return undefined;
  const writtenAtMs = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
  // ponytail: a forged future-dated assistant line placed before the real one wins, and a timestamp without
  // timezone is read as local time. Upgrade path: match the launch's own message uuid, or the file size at launch.
  const isFromThisLaunch = writtenAtMs >= launchedAtMs;
  if (!isFromThisLaunch) return undefined;
  const model = isRecord(entry.message) ? entry.message.model : undefined;
  const version = entry.version;
  const hasValidModel = typeof model === 'string' && isValidModelId(model);
  const hasValidVersion = typeof version === 'string' && CLI_VERSION_PATTERN.test(version);
  return hasValidModel && hasValidVersion ? { resolvedModel: model, cliVersion: version } : undefined;
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
