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
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
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

const CONTEXT_USAGE_FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const;

// The top of the contextNotice settings range: a sum above it is not a context reading, and a sum past the safe
// integer range would make the sessions table unreadable.
const MAX_TRUSTED_CONTEXT_TOKENS = 10_000_000;

type ContextReading = { kind: 'skip' } | { kind: 'no reading' } | { kind: 'tokens'; contextTokens: number };

const SKIP_LINE: ContextReading = { kind: 'skip' };
const NO_READING: ContextReading = { kind: 'no reading' };

// The context size of the latest main-chain assistant line that carries a complete usage: the sum of the three
// input-side fields. A sub-agent line, a line without a usable usage and a synthetic line totalling zero are
// skipped. The scan ends without a reading at a compact boundary (the lines before it are the context that was
// compacted away) and at a line summing above MAX_TRUSTED_CONTEXT_TOKENS (an older line must not stand for it).
export function findLatestContextTokens(tail: string): number | undefined {
  const linesNewestFirst = tail.split('\n').reverse();
  for (const line of linesNewestFirst) {
    const reading = readingOfLine(line);
    if (reading.kind === 'tokens') return reading.contextTokens;
    if (reading.kind === 'no reading') return undefined;
  }
  return undefined;
}

function readingOfLine(line: string): ContextReading {
  const entry = parseJsonObject(line);
  if (!entry) return SKIP_LINE;
  const isCompactBoundary = entry.type === 'system' && entry.subtype === 'compact_boundary';
  if (isCompactBoundary) return NO_READING;
  const isMainChainAssistantLine = entry.type === 'assistant' && entry.isSidechain !== true;
  if (!isMainChainAssistantLine) return SKIP_LINE;
  const usage = isRecord(entry.message) ? entry.message.usage : undefined;
  if (!isRecord(usage)) return SKIP_LINE;
  const fieldValues = CONTEXT_USAGE_FIELDS.map((field) => usage[field]);
  const isCompleteUsage = fieldValues.every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
  if (!isCompleteUsage) return SKIP_LINE;
  const contextTokens = (fieldValues as number[]).reduce((sum, value) => sum + value, 0);
  const isSyntheticLine = contextTokens === 0;
  if (isSyntheticLine) return SKIP_LINE;
  const isBeyondAnyRealContextWindow = contextTokens > MAX_TRUSTED_CONTEXT_TOKENS;
  return isBeyondAnyRealContextWindow ? NO_READING : { kind: 'tokens', contextTokens };
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
