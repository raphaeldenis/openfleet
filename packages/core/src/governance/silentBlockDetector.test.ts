import type { ServerEvent, SilentBlock } from '@openfleet/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../events/eventBus.js';
import { SilentBlockDetector } from './silentBlockDetector.js';

const MINUTE_MS = 60_000;

class FakeScheduler {
  private elapsedMs = 0;
  private nextTimerId = 0;
  private readonly timers = new Map<number, { dueAtMs: number; callback: () => void }>();

  schedule = (callback: () => void, delayMs: number): (() => void) => {
    const timerId = this.nextTimerId++;
    this.timers.set(timerId, { dueAtMs: this.elapsedMs + delayMs, callback });
    return () => { this.timers.delete(timerId); };
  };

  advanceMinutes(minutes: number): void {
    this.elapsedMs += minutes * MINUTE_MS;
    const dueTimers = [...this.timers].filter(([, timer]) => timer.dueAtMs <= this.elapsedMs);
    for (const [timerId, timer] of dueTimers) {
      this.timers.delete(timerId);
      timer.callback();
    }
  }

  get pendingCount(): number { return this.timers.size; }
}

let bus: EventBus;
let scheduler: FakeScheduler;
let detector: SilentBlockDetector;
let announcements: SilentBlock[][];

function startDetector(thresholdMinutes: number): void {
  announcements = [];
  detector = new SilentBlockDetector({ thresholdMinutes, schedule: scheduler.schedule, onChange: (blocks) => announcements.push(blocks) });
  bus.subscribe((event) => detector.handle(event));
}

const waitsOnPrompt = (sessionId: string, stateSince = '2026-10-04T10:00:00.000Z'): ServerEvent => ({ type: 'session.state', sessionId, state: 'waiting_permission', stateSince });
const stateOf = (sessionId: string, state: 'generating' | 'idle'): ServerEvent => ({ type: 'session.state', sessionId, state, stateSince: '2026-10-04T10:03:00.000Z' });

beforeEach(() => {
  bus = new EventBus();
  scheduler = new FakeScheduler();
  startDetector(5);
});

describe('SilentBlockDetector', () => {
  it('raises nothing after 4 minutes on a prompt', () => {
    bus.emit(waitsOnPrompt('s1'));

    scheduler.advanceMinutes(4);

    expect(detector.list()).toEqual([]);
    expect(announcements).toEqual([]);
  });

  it('raises exactly one item for the session at 5 minutes, naming the prompt by when it appeared', () => {
    bus.emit(waitsOnPrompt('s1', '2026-10-04T10:00:00.000Z'));

    scheduler.advanceMinutes(5);
    scheduler.advanceMinutes(10);

    expect(detector.list()).toEqual([{ sessionId: 's1', waitingSince: '2026-10-04T10:00:00.000Z' }]);
    expect(announcements).toHaveLength(1);
  });

  it('raises nothing for a prompt decided at 3 minutes', () => {
    bus.emit(waitsOnPrompt('s1'));
    scheduler.advanceMinutes(3);

    bus.emit(stateOf('s1', 'generating'));
    scheduler.advanceMinutes(10);

    expect(detector.list()).toEqual([]);
    expect(announcements).toEqual([]);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('clears the item when the prompt is decided after it was raised', () => {
    bus.emit(waitsOnPrompt('s1'));
    scheduler.advanceMinutes(6);

    bus.emit(stateOf('s1', 'generating'));

    expect(detector.list()).toEqual([]);
    expect(announcements.at(-1)).toEqual([]);
  });

  it('keeps two sessions independent', () => {
    bus.emit(waitsOnPrompt('s1', '2026-10-04T10:00:00.000Z'));
    scheduler.advanceMinutes(3);
    bus.emit(waitsOnPrompt('s2', '2026-10-04T10:03:00.000Z'));

    scheduler.advanceMinutes(2);
    expect(detector.list()).toEqual([{ sessionId: 's1', waitingSince: '2026-10-04T10:00:00.000Z' }]);

    scheduler.advanceMinutes(3);
    expect(detector.list().map((block) => block.sessionId)).toEqual(['s1', 's2']);

    bus.emit(stateOf('s1', 'idle'));
    expect(detector.list().map((block) => block.sessionId)).toEqual(['s2']);
  });

  it('clears the item when the session closes', () => {
    bus.emit(waitsOnPrompt('s1'));
    scheduler.advanceMinutes(6);

    bus.emit({ type: 'session.closed', sessionId: 's1', reason: 'closed_by_user' });

    expect(detector.list()).toEqual([]);
  });

  it('raises nothing for a prompt whose session closes before the threshold', () => {
    bus.emit(waitsOnPrompt('s1'));

    bus.emit({ type: 'session.closed', sessionId: 's1' });
    scheduler.advanceMinutes(10);

    expect(detector.list()).toEqual([]);
  });

  it('starts over when the session reopens', () => {
    bus.emit(waitsOnPrompt('s1'));
    scheduler.advanceMinutes(4);
    bus.emit({ type: 'session.reopened', sessionId: 's1' });
    bus.emit(waitsOnPrompt('s1', '2026-10-04T10:04:00.000Z'));

    scheduler.advanceMinutes(4);
    expect(detector.list()).toEqual([]);

    scheduler.advanceMinutes(1);
    expect(detector.list()).toEqual([{ sessionId: 's1', waitingSince: '2026-10-04T10:04:00.000Z' }]);
  });

  it('clears the item when the session relaunches', () => {
    bus.emit(waitsOnPrompt('s1'));
    scheduler.advanceMinutes(6);

    bus.emit({ type: 'session.relaunching', sessionId: 's1' });

    expect(detector.list()).toEqual([]);
  });

  it('counts a repeated waiting_permission report as the same prompt', () => {
    bus.emit(waitsOnPrompt('s1', '2026-10-04T10:00:00.000Z'));
    scheduler.advanceMinutes(3);

    bus.emit(waitsOnPrompt('s1', '2026-10-04T10:03:00.000Z'));
    scheduler.advanceMinutes(2);

    expect(detector.list()).toEqual([{ sessionId: 's1', waitingSince: '2026-10-04T10:00:00.000Z' }]);
  });

  it('raises a new item for a second prompt of the same session', () => {
    bus.emit(waitsOnPrompt('s1', '2026-10-04T10:00:00.000Z'));
    scheduler.advanceMinutes(6);
    bus.emit(stateOf('s1', 'generating'));

    bus.emit(waitsOnPrompt('s1', '2026-10-04T10:07:00.000Z'));
    scheduler.advanceMinutes(5);

    expect(detector.list()).toEqual([{ sessionId: 's1', waitingSince: '2026-10-04T10:07:00.000Z' }]);
  });

  it('ignores the events that say nothing about a prompt', () => {
    bus.emit({ type: 'session.reopened', sessionId: 'other' });
    bus.emit({ type: 'session.output', sessionId: 's1', data: 'x' });

    expect(announcements).toEqual([]);
  });

  it('follows a configured threshold', () => {
    startDetector(1);
    bus.emit(waitsOnPrompt('s9'));

    scheduler.advanceMinutes(1);

    expect(detector.list().map((block) => block.sessionId)).toEqual(['s9']);
  });

  it('stops every pending timer when stopped', () => {
    bus.emit(waitsOnPrompt('s1'));

    detector.stop();
    scheduler.advanceMinutes(10);

    expect(detector.list()).toEqual([]);
    expect(scheduler.pendingCount).toBe(0);
  });
});
