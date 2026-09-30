import type { DaemonIssue } from '@openfleet/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDegradedRegistry, type DegradedRegistry } from './degradedRegistry.js';

const MINUTE_MS = 60_000;
const REF_PATTERN = /^[0-9a-f]{8}$/;

describe('the degraded registry', () => {
  let nowMs: number;
  let registry: DegradedRegistry;
  let changes: DaemonIssue[][];

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    nowMs = Date.parse('2026-09-30T10:00:00.000Z');
    registry = createDegradedRegistry({ clock: () => nowMs });
    changes = [];
    registry.onChange((issues) => changes.push(issues));
  });

  it('starts healthy, with no issue', () => {
    expect(registry.status()).toBe('ok');
    expect(registry.list()).toEqual([]);
  });

  it('records an issue with its code, first appearance, message, ref and a count of one', () => {
    registry.mark('db_stuck', 'the database is not accepting writes.');

    expect(registry.status()).toBe('degraded');
    expect(registry.list()).toEqual([{ code: 'db_stuck', since: '2026-09-30T10:00:00.000Z', message: 'the database is not accepting writes.', id: expect.stringMatching(REF_PATTERN), count: 1 }]);
  });

  it('keeps the first appearance and the ref when the same code is marked again, and only raises the count', () => {
    registry.mark('db_stuck', 'the database is not accepting writes.');
    const [first] = registry.list();
    nowMs += MINUTE_MS;

    registry.mark('db_stuck', 'the database is not accepting writes.');

    expect(registry.list()).toEqual([{ ...first, count: 2 }]);
  });

  it('announces the full list on an appearance and on a clear, and nothing else', () => {
    registry.mark('db_stuck', 'one.');
    registry.mark('db_stuck', 'one.');
    registry.mark('hook_fail_open', 'two.');
    registry.clear('db_stuck');
    registry.clear('db_stuck');

    expect(changes.map((issues) => issues.map((issue) => issue.code))).toEqual([['db_stuck'], ['db_stuck', 'hook_fail_open'], ['hook_fail_open']]);
  });

  it('announces a new ref for a code already marked: a second crash is news', () => {
    registry.mark('uncaught_exception', 'an unexpected error escaped the daemon.', { id: 'aaaaaaaa' });

    registry.mark('uncaught_exception', 'an unexpected error escaped the daemon.', { id: 'bbbbbbbb' });

    expect(registry.list()).toMatchObject([{ id: 'bbbbbbbb', count: 2 }]);
    expect(changes).toHaveLength(2);
  });

  it('caps and masks the message: a bearer, a control character and a 5 KiB text never reach an issue', () => {
    registry.mark('db_stuck', `Bearer sk-secret-token-value\u0000\u001b[31m ${'x'.repeat(5000)}`);

    const [{ message }] = registry.list() as [DaemonIssue];
    expect(message).not.toContain('sk-secret-token-value');
    expect(message).not.toMatch(/[\u0000-\u001f]/);
    expect(message.length).toBeLessThanOrEqual(300);
  });

  it('keeps answering when a listener throws, and still tells the others', () => {
    const afterTheThrowingOne = vi.fn();
    registry.onChange(() => { throw new Error('listener bug'); });
    registry.onChange(afterTheThrowingOne);

    expect(() => registry.mark('db_stuck', 'one.')).not.toThrow();

    expect(afterTheThrowingOne).toHaveBeenCalledTimes(1);
    expect(registry.list()).toHaveLength(1);
  });

  it('stops telling a listener once it unsubscribed', () => {
    const listener = vi.fn();
    const unsubscribe = registry.onChange(listener);
    unsubscribe();

    registry.mark('db_stuck', 'one.');

    expect(listener).not.toHaveBeenCalled();
  });

  it('never grows past one issue per source', () => {
    for (let occurrence = 0; occurrence < 1000; occurrence += 1) registry.mark('ws_broadcast_failed', 'a client did not receive an event.');

    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]!.count).toBe(1000);
  });

  describe('hook_fail_open', () => {
    it('stays quiet for two hook failures in five minutes', () => {
      registry.recordHookFailOpen();
      registry.recordHookFailOpen();

      expect(registry.status()).toBe('ok');
    });

    it('marks the third hook failure within five minutes', () => {
      registry.recordHookFailOpen();
      nowMs += MINUTE_MS;
      registry.recordHookFailOpen();
      nowMs += MINUTE_MS;
      registry.recordHookFailOpen();

      expect(registry.list()).toMatchObject([{ code: 'hook_fail_open', count: 1 }]);
    });

    it('forgets failures older than five minutes: three spread over ten minutes never mark', () => {
      registry.recordHookFailOpen();
      nowMs += 4 * MINUTE_MS;
      registry.recordHookFailOpen();
      nowMs += 4 * MINUTE_MS;
      registry.recordHookFailOpen();

      expect(registry.status()).toBe('ok');
    });

    it('clears after five clean minutes and announces the clear', () => {
      for (let failure = 0; failure < 3; failure += 1) registry.recordHookFailOpen();
      nowMs += 4 * MINUTE_MS;
      expect(registry.status()).toBe('degraded');

      nowMs += MINUTE_MS + 1;

      expect(registry.list()).toEqual([]);
      expect(changes.at(-1)).toEqual([]);
    });

    it('keeps an issue marked directly, without counted failures, until it is cleared', () => {
      registry.mark('hook_fail_open', 'hooks fail open.');
      nowMs += 10 * MINUTE_MS;

      expect(registry.status()).toBe('degraded');
    });

    it('stays marked while failures keep coming', () => {
      for (let failure = 0; failure < 3; failure += 1) registry.recordHookFailOpen();
      nowMs += 4 * MINUTE_MS;
      registry.recordHookFailOpen();
      nowMs += 4 * MINUTE_MS;

      expect(registry.status()).toBe('degraded');
    });
  });
});
