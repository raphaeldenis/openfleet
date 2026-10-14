import type { ServerEvent, SilentBlock } from '@openfleet/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { SilentBlockDetector } from './silentBlockDetector.js';

class FakeScheduler {
  private elapsedMs = 0;
  private nextTimerId = 0;
  readonly delaysAskedMs: number[] = [];
  private readonly timers = new Map<number, { dueAtMs: number; callback: () => void }>();

  schedule = (callback: () => void, delayMs: number): (() => void) => {
    const timerId = this.nextTimerId++;
    this.delaysAskedMs.push(delayMs);
    this.timers.set(timerId, { dueAtMs: this.elapsedMs + delayMs, callback });
    return () => { this.timers.delete(timerId); };
  };

  advanceSeconds(seconds: number): void {
    this.elapsedMs += seconds * 1000;
    for (const [timerId, timer] of [...this.timers].filter(([, candidate]) => candidate.dueAtMs <= this.elapsedMs)) {
      this.timers.delete(timerId);
      timer.callback();
    }
  }
}

const waitsOnPrompt = (sessionId: string): ServerEvent => ({ type: 'session.state', sessionId, state: 'waiting_permission', stateSince: '2026-10-14T10:00:00.000Z' });
const leavesPrompt = (sessionId: string): ServerEvent => ({ type: 'session.state', sessionId, state: 'generating', stateSince: '2026-10-14T10:00:20.000Z' });

let scheduler: FakeScheduler;
let detector: SilentBlockDetector;
let announcements: SilentBlock[][];
let raisedPrompts: { sessionId: string; wasUnwatched: boolean }[];
let unwatchedSessions: Set<string>;

beforeEach(() => {
  scheduler = new FakeScheduler();
  announcements = [];
  raisedPrompts = [];
  unwatchedSessions = new Set(['child']);
  detector = new SilentBlockDetector({
    thresholdMinutes: 5,
    unattended: { thresholdSeconds: 30, appliesTo: (sessionId) => unwatchedSessions.has(sessionId) },
    schedule: scheduler.schedule,
    onChange: (blocks) => announcements.push(blocks),
    onRaised: (raised) => raisedPrompts.push(raised),
  });
});

describe('SilentBlockDetector for a session nobody watches', () => {
  it('raises nothing at 29 seconds and one item at 30 seconds', () => {
    detector.handle(waitsOnPrompt('child'));

    scheduler.advanceSeconds(29);
    expect(detector.list()).toEqual([]);
    scheduler.advanceSeconds(1);

    expect(detector.list()).toEqual([{ sessionId: 'child', waitingSince: '2026-10-14T10:00:00.000Z' }]);
    expect(announcements).toHaveLength(1);
  });

  it('keeps the five minutes for a session somebody watches', () => {
    detector.handle(waitsOnPrompt('human'));

    scheduler.advanceSeconds(299);
    expect(detector.list()).toEqual([]);
    scheduler.advanceSeconds(1);

    expect(detector.list().map((block) => block.sessionId)).toEqual(['human']);
    expect(scheduler.delaysAskedMs).toEqual([300_000]);
  });

  it('tells the owner of the net once per raised prompt, and which wait it was under', () => {
    detector.handle(waitsOnPrompt('child'));
    detector.handle(waitsOnPrompt('human'));

    scheduler.advanceSeconds(30);
    scheduler.advanceSeconds(300);

    expect(raisedPrompts).toEqual([{ sessionId: 'child', wasUnwatched: true }, { sessionId: 'human', wasUnwatched: false }]);
  });

  it('raises nothing and tells nobody for a prompt the session leaves in time', () => {
    detector.handle(waitsOnPrompt('child'));
    scheduler.advanceSeconds(20);

    detector.handle(leavesPrompt('child'));
    scheduler.advanceSeconds(60);

    expect(detector.list()).toEqual([]);
    expect(raisedPrompts).toEqual([]);
  });

  it('decides who is unwatched when the prompt appears, not when it was configured', () => {
    unwatchedSessions.clear();
    detector.handle(waitsOnPrompt('child'));

    scheduler.advanceSeconds(30);

    expect(detector.list()).toEqual([]);
  });

  it('keeps the five minutes for every session when no unattended threshold is configured', () => {
    detector = new SilentBlockDetector({ thresholdMinutes: 5, schedule: scheduler.schedule, onChange: () => undefined });
    detector.handle(waitsOnPrompt('child'));

    scheduler.advanceSeconds(30);

    expect(detector.list()).toEqual([]);
  });
});
