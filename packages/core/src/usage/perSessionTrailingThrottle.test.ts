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
  const moveClockWithoutFiringTimers = (targetMs: number) => { nowMs = targetMs; };
  return { throttle, runScheduled, advanceTo, moveClockWithoutFiringTimers, pendingTimerCount: () => timers.size };
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

  it('waits at most one window for the trailing task when the clock jumps back', () => {
    const { throttle, runScheduled, advanceTo } = newThrottle();
    const trailingTask = vi.fn();
    advanceTo(3_600_000);
    throttle.request('s1', vi.fn());
    runScheduled();

    advanceTo(0);
    throttle.request('s1', trailingTask);
    advanceTo(WINDOW_MS);

    expect(trailingTask).toHaveBeenCalledTimes(1);
  });

  it('runs a request made after a late timer right away and never replays the older trailing task', () => {
    const { throttle, runScheduled, advanceTo, moveClockWithoutFiringTimers, pendingTimerCount } = newThrottle();
    const olderTrailingTask = vi.fn();
    const newerTask = vi.fn();
    throttle.request('s1', vi.fn());
    runScheduled();
    advanceTo(400);
    throttle.request('s1', olderTrailingTask);

    moveClockWithoutFiringTimers(WINDOW_MS + 500);
    throttle.request('s1', newerTask);
    runScheduled();
    advanceTo(3 * WINDOW_MS);

    expect([olderTrailingTask.mock.calls.length, newerTask.mock.calls.length, pendingTimerCount()]).toEqual([0, 1, 0]);
  });

  describe('dispose', () => {
    it('runs the pending trailing task once and cancels its timer', () => {
      const { throttle, runScheduled, advanceTo, pendingTimerCount } = newThrottle();
      const trailingTask = vi.fn();
      throttle.request('s1', vi.fn());
      runScheduled();
      throttle.request('s1', trailingTask);

      throttle.dispose();
      advanceTo(WINDOW_MS);

      expect([trailingTask.mock.calls.length, pendingTimerCount()]).toEqual([1, 0]);
    });

    it('runs the pending trailing task of every session', () => {
      const { throttle, runScheduled } = newThrottle();
      const trailingTasks = [vi.fn(), vi.fn()];
      throttle.request('s1', vi.fn());
      throttle.request('s2', vi.fn());
      runScheduled();
      throttle.request('s1', trailingTasks[0]!);
      throttle.request('s2', trailingTasks[1]!);

      throttle.dispose();

      expect(trailingTasks.map((task) => task.mock.calls.length)).toEqual([1, 1]);
    });

    it('ignores the requests made after it', () => {
      const { throttle, runScheduled, advanceTo, pendingTimerCount } = newThrottle();
      const task = vi.fn();
      throttle.dispose();

      throttle.request('s1', task);
      runScheduled();
      advanceTo(WINDOW_MS);

      expect([task.mock.calls.length, pendingTimerCount()]).toEqual([0, 0]);
    });
  });

  describe('forget', () => {
    it('drops a task scheduled before the forget even when the session asks again before it runs', () => {
      const { throttle, runScheduled } = newThrottle();
      const droppedTask = vi.fn();
      const newTask = vi.fn();
      throttle.request('s1', droppedTask);

      throttle.forget('s1');
      throttle.request('s1', newTask);
      runScheduled();

      expect([droppedTask.mock.calls.length, newTask.mock.calls.length]).toEqual([0, 1]);
    });

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
