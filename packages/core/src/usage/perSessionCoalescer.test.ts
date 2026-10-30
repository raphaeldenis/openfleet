import { describe, expect, it, vi } from 'vitest';
import { PerSessionCoalescer } from './perSessionCoalescer.js';

function newCoalescer() {
  const scheduled: (() => void)[] = [];
  const coalescer = new PerSessionCoalescer((task) => scheduled.push(task));
  const runScheduled = () => scheduled.splice(0).forEach((task) => task());
  return { coalescer, scheduled, runScheduled };
}

describe('PerSessionCoalescer', () => {
  it('runs a task once for any number of requests made before it runs', () => {
    const { coalescer, runScheduled } = newCoalescer();
    const task = vi.fn();

    for (let request = 0; request < 50; request += 1) coalescer.request('s1', task);
    runScheduled();

    expect(task).toHaveBeenCalledTimes(1);
  });

  it('runs one task per session', () => {
    const { coalescer, runScheduled } = newCoalescer();
    const firstTask = vi.fn();
    const secondTask = vi.fn();

    coalescer.request('s1', firstTask);
    coalescer.request('s2', secondTask);
    runScheduled();

    expect([firstTask.mock.calls.length, secondTask.mock.calls.length]).toEqual([1, 1]);
  });

  it('accepts a new request once the previous task has run', () => {
    const { coalescer, runScheduled } = newCoalescer();
    const task = vi.fn();

    coalescer.request('s1', task);
    runScheduled();
    coalescer.request('s1', task);
    runScheduled();

    expect(task).toHaveBeenCalledTimes(2);
  });

  it('accepts a new request after a task that threw', () => {
    const { coalescer, runScheduled } = newCoalescer();
    const failingTask = vi.fn(() => { throw new Error('boom'); });
    const nextTask = vi.fn();

    coalescer.request('s1', failingTask);
    expect(runScheduled).toThrow();
    coalescer.request('s1', nextTask);
    runScheduled();

    expect(nextTask).toHaveBeenCalledTimes(1);
  });
});
