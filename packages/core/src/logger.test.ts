import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from './logger.js';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('log', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('writes an info line to console.log with an ISO timestamp, the level and the message', () => {
    log('info', 'daemon listening on http://127.0.0.1:7331');

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [line] = logSpy.mock.calls[0]!;
    expect(line).toMatch(new RegExp(`^${ISO_TIMESTAMP.source.slice(1, -1)} INFO daemon listening on http://127\\.0\\.0\\.1:7331$`));
  });

  it('writes a warn line to console.warn', () => {
    log('warn', 'skipping an out-of-bounds row');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
    expect((warnSpy.mock.calls[0]![0] as string)).toContain(' WARN skipping an out-of-bounds row');
  });

  it('writes an error line to console.error, with an attached error object passed through unformatted so its stack survives', () => {
    const error = new Error('boom');

    log('error', 'relaunch failed', error);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [line, detail] = errorSpy.mock.calls[0]!;
    expect(line as string).toContain(' ERROR relaunch failed');
    expect(detail).toBe(error);
  });

  it('omits the detail argument entirely when none is given, rather than logging undefined', () => {
    log('info', 'no detail here');

    expect(logSpy.mock.calls[0]).toEqual([expect.stringContaining('no detail here')]);
  });
});
