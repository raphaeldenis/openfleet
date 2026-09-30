import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forceNdjsonLogging } from './forceNdjsonLogging.testkit.js';
import { log } from './logger.js';

const isTtyOf = (stream: NodeJS.WriteStream) => Object.getOwnPropertyDescriptor(stream, 'isTTY');
const restore = (stream: NodeJS.WriteStream, before: PropertyDescriptor | undefined) => {
  if (before) Object.defineProperty(stream, 'isTTY', before);
  else delete (stream as { isTTY?: boolean }).isTTY;
};

const beforeStdout = isTtyOf(process.stdout);
const beforeStderr = isTtyOf(process.stderr);

describe('forceNdjsonLogging', () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
  });
  afterEach(() => {
    restore(process.stdout, beforeStdout);
    restore(process.stderr, beforeStderr);
    vi.restoreAllMocks();
  });

  it('makes info, warn and error print one NDJSON line each while stdout and stderr are terminals', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    forceNdjsonLogging();

    log('info', 'to stdout');
    log('warn', 'to stderr');
    log('error', 'to stderr');

    const printed = [consoleLog, consoleWarn, consoleError].map((spy) => JSON.parse(String(spy.mock.calls[0]![0])).level);
    expect(printed).toEqual(['info', 'warn', 'error']);
  });
});
