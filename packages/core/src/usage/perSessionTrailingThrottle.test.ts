import { describe, expect, it, vi } from 'vitest';
import { PerSessionTrailingThrottle } from './perSessionTrailingThrottle.js';

const WINDOW_MS = 1000;

function newThrottle() {
  let nowMs = 0;
  const scheduled: (() => void)[] = [];
  const timers = new Map<number, { dueAtMs: number; task: () => void }>();
  let nextTimerId = 0;
  const throttle = new PerSessionTrailingThrottle({
    windowMs: WINDOW_MS,
    clock: () => nowMs,
    schedule: (task) => scheduled.push(task),
    startTimer: (task, delayMs) => {
      const timerId = nextTimerId++;
      timers.set(timerId, { dueAtMs: nowMs + delayMs, task });
      return () => timers.delete(timerId);
    },
  });
  const runScheduled = () => scheduled.splice(0).forEach((task) => task());
  const advanceTo = (targetMs: number) => {
    nowMs = targetMs;
    for (const [timerId, { dueAtMs, task }] of [...timers]) {
      if (dueAtMs > nowMs) continue;
      timers.delete(timerId);
      task();
    }
  };
  return { throttle, runScheduled, advanceTo, pendingTimerCount: () => timers.size };
}

describe('PerSessionTrailingThrottle', () => {
  it('runs the first request of a session once the scheduler gets to it', () => {
    const { throttle, runScheduled } = newThrottle();
    const task = vi.fn();

    throttle.request('s1', task);
    expect(task).not.toHaveBeenCalled();
    runScheduled();

    expect(task).toHaveBeenCalledTimes(1);
  });

  it('runs one task now and one trailing task at the end of the window for any number of requests inside the window', () => {
    const { throttle, runScheduled, advanceTo } = newThrottle();
    const task = vi.fn();

    for (let request = 0; request < 50; request += 1) throttle.request('s1', task);
    runScheduled();
    advanceTo(WINDOW_MS - 1);
    const callsBeforeTheWindowEnds = task.mock.calls.length;
    advanceTo(WINDOW_MS);

    expect([callsBeforeTheWindowEnds, task.mock.calls.length]).toEqual([1, 2]);
  });

  it('defers a request made inside the window to the end of the window instead of dropping it', () => {
    const { throttle, runScheduled, advanceTo } = newThrottle();
    const firstTask = vi.fn();
    const lastTask = vi.fn();
    throttle.request('s1', firstTask);
    runScheduled();

    advanceTo(400);
    throttle.request('s1', lastTask);
    advanceTo(WINDOW_MS);

    expect(lastTask).toHaveBeenCalledTimes(1);
  });

  it('runs a request made after the window right away and opens a new window', () => {
    const { throttle, runScheduled, advanceTo } = newThrottle();
    const task = vi.fn();
    throttle.request('s1', task);
    runScheduled();

    advanceTo(WINDOW_MS);
    throttle.request('s1', task);
    runScheduled();
    throttle.request('s1', task);
    advanceTo(WINDOW_MS + 1);

    expect(task).toHaveBeenCalledTimes(2);
  });

  it('keeps one window per session', () => {
    const { throttle, runScheduled } = newThrottle();
    const firstTask = vi.fn();
    const secondTask = vi.fn();

    throttle.request('s1', firstTask);
    throttle.request('s2', secondTask);
    runScheduled();

    expect([firstTask.mock.calls.length, secondTask.mock.calls.length]).toEqual([1, 1]);
  });

  it('accepts a new request after a task that threw', () => {
    const { throttle, runScheduled, advanceTo } = newThrottle();
    const failingTask = vi.fn(() => { throw new Error('boom'); });
    const nextTask = vi.fn();

    throttle.request('s1', failingTask);
    expect(runScheduled).toThrow();
    advanceTo(WINDOW_MS);
    throttle.request('s1', nextTask);
    runScheduled();

    expect(nextTask).toHaveBeenCalledTimes(1);
  });

  it('keeps a trailing request alive after the trailing task of the previous window threw', () => {
    const { throttle, runScheduled, advanceTo } = newThrottle();
    const failingTask = vi.fn(() => { throw new Error('boom'); });
    const nextTask = vi.fn();
    throttle.request('s1', vi.fn());
    runScheduled();
    throttle.request('s1', failingTask);
    expect(() => advanceTo(WINDOW_MS)).toThrow();

    advanceTo(2 * WINDOW_MS);
    throttle.request('s1', nextTask);
    runScheduled();

    expect(nextTask).toHaveBeenCalledTimes(1);
  });

  describe('forget', () => {
    it('cancels the trailing timer of the session', () => {
      const { throttle, runScheduled, advanceTo, pendingTimerCount } = newThrottle();
      const task = vi.fn();
      throttle.request('s1', vi.fn());
      runScheduled();
      throttle.request('s1', task);

      throttle.forget('s1');
      advanceTo(WINDOW_MS);

      expect([pendingTimerCount(), task.mock.calls.length]).toEqual([0, 0]);
    });

    it('drops a task scheduled but not yet run', () => {
      const { throttle, runScheduled } = newThrottle();
      const task = vi.fn();
      throttle.request('s1', task);

      throttle.forget('s1');
      runScheduled();

      expect(task).not.toHaveBeenCalled();
    });

    it('leaves the other sessions alone', () => {
      const { throttle, runScheduled, advanceTo } = newThrottle();
      const otherTrailingTask = vi.fn();
      throttle.request('s2', vi.fn());
      runScheduled();
      throttle.request('s2', otherTrailingTask);

      throttle.forget('s1');
      advanceTo(WINDOW_MS);

      expect(otherTrailingTask).toHaveBeenCalledTimes(1);
    });
  });
});
