import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLOSED_SNAPSHOTS_KEPT, EMIT_COALESCE_MS, MAX_QUEUED_HOOKS, type SessionTodos } from '@openfleet/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../events/eventBus.js';
import { recentLogLines } from '../logger.js';
import { narrowTodoHookCall, type TodoHookCall } from './todoHookCall.js';
import { FALLBACK_READ_DELAYS_MS, TodoTracker, type Schedule } from './todoTracker.js';
import type { readTranscriptChunk } from './transcriptChunkReader.js';

const NOW = new Date('2026-09-30T17:00:00.000Z');
const SESSION = 'session-1';

const fakeClock = () => {
  const timers: { run: () => void; at: number; isCancelled: boolean; hasFired: boolean }[] = [];
  let now = 0;
  const schedule: Schedule = (run, delayMs) => {
    const timer = { run, at: now + delayMs, isCancelled: false, hasFired: false };
    timers.push(timer);
    return () => { timer.isCancelled = true; };
  };
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers) {
      if (timer.isCancelled || timer.hasFired || timer.at > now) continue;
      timer.hasFired = true;
      timer.run();
    }
  };
  const pendingCount = () => timers.filter((timer) => !timer.isCancelled && !timer.hasFired).length;
  return { schedule, advance, pendingCount };
};

const nextTurns = async (count = 5) => { for (let turn = 0; turn < count; turn += 1) await new Promise((resolve) => setImmediate(resolve)); };

const createCall = (toolUseId: string, taskId: string, subject: string): TodoHookCall => narrowTodoHookCall({ tool_name: 'TaskCreate', tool_use_id: toolUseId, tool_input: { subject }, tool_response: { task: { id: taskId, subject } } })!;
const callWithoutPayload = (toolUseId: string): TodoHookCall => narrowTodoHookCall({ tool_name: 'TaskCreate', tool_use_id: toolUseId })!;

const assistantLine = (toolUseId: string, name: string, input: unknown) => JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name, input }] } });
const resultLine = (toolUseId: string, toolUseResult: unknown) => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] }, toolUseResult });
const transcriptCreate = (toolUseId: string, taskId: string, subject: string) => [assistantLine(toolUseId, 'TaskCreate', { subject }), resultLine(toolUseId, { task: { id: taskId, subject } })];

let directory: string;
let paths: Map<string, string | undefined>;
let bus: EventBus;
let clock: ReturnType<typeof fakeClock>;
let emitted: SessionTodos[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'of-todo-tracker-'));
  paths = new Map();
  bus = new EventBus();
  clock = fakeClock();
  emitted = [];
});

const newTracker = (options: { readChunk?: typeof readTranscriptChunk; getWaitMs?: number } = {}) => {
  const tracker = new TodoTracker({ sessions: { get: () => ({ createdAt: '2026-09-30T00:00:00.000Z' }), trustedTranscriptFileOf: (id) => paths.get(id) }, bus, schedule: clock.schedule, now: () => NOW, ...options });
  tracker.onUpdate((todos) => emitted.push(todos));
  return tracker;
};
const rowsOf = (todos: SessionTodos | undefined) => todos?.items.map((item) => `${item.id}:${item.status}:${item.content}`);
const transcriptPath = (name = 'one.jsonl') => join(directory, name);

describe('the hook only enqueues: the fold runs after the caller returned', () => {
  it('has not folded the call when applyHook returns, and has after the next turn of the event loop', async () => {
    const tracker = newTracker();

    tracker.applyHook(SESSION, createCall('toolu_1', '1', 'Plan it'));
    const rightAfterTheCall = tracker.get(SESSION);
    await nextTurns(1);

    expect(rightAfterTheCall?.counts.total).toBe(0);
    expect(tracker.get(SESSION)?.counts.total).toBe(1);
  });
});

describe('events are coalesced', () => {
  it('sends one event for 20 creates folded inside one window, and none when nothing changed since', async () => {
    const tracker = newTracker();

    for (let index = 1; index <= 20; index += 1) {
      tracker.applyHook(SESSION, createCall(`toolu_${index}`, String(index), `Task ${index}`));
      await nextTurns(2);
    }
    clock.advance(EMIT_COALESCE_MS);
    tracker.applyHook(SESSION, createCall('toolu_1', '1', 'Task 1'));
    await nextTurns();
    clock.advance(EMIT_COALESCE_MS);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.counts.total).toBe(20);
  });

  it('never emits the empty baseline of a session that only had a GET', async () => {
    const tracker = newTracker();

    await tracker.read(SESSION);
    clock.advance(EMIT_COALESCE_MS);

    expect(emitted).toEqual([]);
  });
});

describe('a hook queue that overflows', () => {
  it('drops the oldest hook folds past MAX_QUEUED_HOOKS and restores them from the transcript at the catch-up read', async () => {
    const tracker = newTracker();
    const total = MAX_QUEUED_HOOKS + 50;
    const lines = Array.from({ length: total }, (_, index) => transcriptCreate(`toolu_${index}`, String(index + 1), `Task ${index + 1}`)).flat();
    writeFileSync(transcriptPath(), `${lines.join('\n')}\n`);
    paths.set(SESSION, transcriptPath());

    for (let index = 0; index < total; index += 1) tracker.applyHook(SESSION, createCall(`toolu_${index}`, String(index + 1), `Task ${index + 1}`));
    const restored = await tracker.read(SESSION);

    expect(restored.counts.total).toBe(total);
  });

  it('keeps the hook folds it could not keep out of the list when no transcript can restore them', async () => {
    const tracker = newTracker();
    const total = MAX_QUEUED_HOOKS + 50;

    for (let index = 0; index < total; index += 1) tracker.applyHook(SESSION, createCall(`toolu_${index}`, String(index + 1), `Task ${index + 1}`));
    const todos = await tracker.read(SESSION);

    expect(todos.counts.total).toBe(MAX_QUEUED_HOOKS);
  });
});

describe('a todo hook without a usable payload falls back to reading the transcript, after growing delays', () => {
  const setUpALateLine = () => {
    const tracker = newTracker();
    writeFileSync(transcriptPath(), '');
    paths.set(SESSION, transcriptPath());
    return tracker;
  };

  it('reads again at +150, +450 and +1050 ms and finds a line that was written at +900 ms, then stops', async () => {
    const tracker = setUpALateLine();
    tracker.applyHook(SESSION, callWithoutPayload('toolu_late'));
    await nextTurns();

    clock.advance(150);
    await tracker.read(SESSION);
    const atFirstRead = tracker.get(SESSION)?.counts.total;
    clock.advance(300);
    await tracker.read(SESSION);
    const atSecondRead = tracker.get(SESSION)?.counts.total;
    appendFileSync(transcriptPath(), `${transcriptCreate('toolu_late', '1', 'Written late').join('\n')}\n`);
    clock.advance(600);
    await tracker.read(SESSION);
    clock.advance(EMIT_COALESCE_MS);

    expect([atFirstRead, atSecondRead]).toEqual([0, 0]);
    expect(rowsOf(tracker.get(SESSION))).toEqual(['1:pending:Written late']);
    expect(clock.pendingCount()).toBe(0);
  });

  it('gives up after the fifth read, about 4.65 s in, and leaves no timer behind', async () => {
    const tracker = setUpALateLine();
    tracker.applyHook(SESSION, callWithoutPayload('toolu_never'));
    await nextTurns();

    let waited = 0;
    for (const delay of FALLBACK_READ_DELAYS_MS) {
      clock.advance(delay);
      waited += delay;
      await tracker.read(SESSION);
    }

    clock.advance(EMIT_COALESCE_MS);
    expect(waited).toBe(4650);
    expect(clock.pendingCount()).toBe(0);
    expect(tracker.get(SESSION)?.counts.total).toBe(0);
  });

  it('is repaired by the next catch-up read when the line comes after the fallback gave up', async () => {
    const tracker = setUpALateLine();
    tracker.applyHook(SESSION, callWithoutPayload('toolu_never'));
    for (const delay of FALLBACK_READ_DELAYS_MS) {
      clock.advance(delay);
      await tracker.read(SESSION);
    }

    appendFileSync(transcriptPath(), `${transcriptCreate('toolu_never', '1', 'Finally here').join('\n')}\n`);
    tracker.catchUp(SESSION);

    expect(rowsOf(await tracker.read(SESSION))).toEqual(['1:pending:Finally here']);
  });
});

describe('the list of a closed session', () => {
  it('is kept as its last snapshot, the fold is freed, and only the last 50 closed sessions are kept', async () => {
    const tracker = newTracker();
    const ids = Array.from({ length: CLOSED_SNAPSHOTS_KEPT + 1 }, (_, index) => `closed-${index}`);

    for (const id of ids) {
      tracker.applyHook(id, createCall(`toolu_${id}`, '1', `List of ${id}`));
      await nextTurns(1);
      bus.emit({ type: 'session.closed', sessionId: id });
    }
    await nextTurns();

    expect(tracker.get(ids[0]!)).toBeUndefined();
    expect(rowsOf(tracker.get(ids.at(-1)!))).toEqual([`1:pending:List of ${ids.at(-1)}`]);
    expect(tracker.summaries()).toHaveLength(CLOSED_SNAPSHOTS_KEPT);
    expect((tracker as unknown as { states: Map<string, unknown> }).states.size).toBe(0);
  });

  it('forgets the kept snapshot of a session that is reopened, so a stale list is not shown as current', async () => {
    const tracker = newTracker();
    tracker.applyHook(SESSION, createCall('toolu_1', '1', 'Before close'));
    await nextTurns();
    bus.emit({ type: 'session.closed', sessionId: SESSION });

    bus.emit({ type: 'session.reopened', sessionId: SESSION });

    expect(tracker.get(SESSION)).toBeUndefined();
  });

  it('still applies the hook folds queued before the close, and sends the final snapshot once', async () => {
    const tracker = newTracker();
    tracker.applyHook(SESSION, createCall('toolu_1', '1', 'Queued before the close'));

    bus.emit({ type: 'session.closed', sessionId: SESSION });
    await nextTurns();
    clock.advance(EMIT_COALESCE_MS);

    expect(rowsOf(tracker.get(SESSION))).toEqual(['1:pending:Queued before the close']);
    expect(emitted).toHaveLength(1);
  });
});

describe('a fault inside a fold', () => {
  const throwingCall = (): TodoHookCall => ({ get toolUseId(): string { throw new Error('boom SECRET-TEXT'); }, name: 'TaskCreate', input: {}, response: undefined });

  it('marks the list stale, logs one warning with a code and no text, and keeps folding the next calls', async () => {
    const tracker = newTracker();
    tracker.applyHook(SESSION, createCall('toolu_1', '1', 'Kept'));

    tracker.applyHook(SESSION, throwingCall());
    tracker.applyHook(SESSION, throwingCall());
    tracker.applyHook(SESSION, createCall('toolu_2', '2', 'Also kept'));
    const todos = await tracker.read(SESSION);

    const warnings = recentLogLines().filter((line) => line.includes('todo_fold_failed') && line.includes(SESSION));
    expect(todos.stale).toBe(true);
    expect(rowsOf(todos)).toEqual(['1:pending:Kept', '2:pending:Also kept']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain('SECRET-TEXT');
  });

  it('clears the stale flag when a later read of the transcript succeeds', async () => {
    const tracker = newTracker();
    tracker.applyHook(SESSION, throwingCall());
    await tracker.read(SESSION);
    writeFileSync(transcriptPath(), `${transcriptCreate('toolu_1', '1', 'From the file').join('\n')}\n`);
    paths.set(SESSION, transcriptPath());

    tracker.catchUp(SESSION);
    const todos = await tracker.read(SESSION);

    expect(todos.stale).toBeUndefined();
    expect(rowsOf(todos)).toEqual(['1:pending:From the file']);
  });

  it('marks the list stale, without throwing, when the read fails', async () => {
    const tracker = newTracker({ readChunk: () => { throw Object.assign(new Error('EIO at /secret/path'), { code: 'EIO' }); } });
    paths.set(SESSION, transcriptPath());
    tracker.applyHook(SESSION, createCall('toolu_1', '1', 'Kept'));

    tracker.catchUp(SESSION);
    const todos = await tracker.read(SESSION);

    expect(todos.stale).toBe(true);
    expect(rowsOf(todos)).toEqual(['1:pending:Kept']);
  });
});

describe('a session that moves to another transcript file', () => {
  it('keeps its list, reads the new file from its start, and never shows an empty list in between', async () => {
    const tracker = newTracker();
    const first = transcriptPath('first.jsonl');
    const second = transcriptPath('second.jsonl');
    writeFileSync(first, `${transcriptCreate('toolu_1', '1', 'Before the clear').join('\n')}\n`);
    writeFileSync(second, `${transcriptCreate('toolu_2', '2', 'After the clear').join('\n')}\n`);
    paths.set(SESSION, first);
    tracker.repair(SESSION);
    await tracker.read(SESSION);

    paths.set(SESSION, second);
    tracker.catchUp(SESSION);
    const todos = await tracker.read(SESSION);
    clock.advance(EMIT_COALESCE_MS);

    expect(rowsOf(todos)).toEqual(['1:pending:Before the clear', '2:pending:After the clear']);
    expect(emitted.every((update) => update.counts.total > 0)).toBe(true);
  });
});

describe('a read that takes longer than the REST route waits', () => {
  /** A reader that reports a huge file it makes slow progress on, until told to finish. */
  const endlessReader = () => {
    const control = { isDone: false, reads: 0 };
    const readChunk: typeof readTranscriptChunk = (_path, request) => {
      control.reads += 1;
      const nextOffset = request.offset + 10;
      return { kind: 'chunk', text: '', nextOffset, inode: 1, size: control.isDone ? nextOffset : nextOffset + 1_000_000 };
    };
    return { control, readChunk };
  };

  it('answers within the wait with the last known list marked stale, then without the mark once the read finished', async () => {
    const { control, readChunk } = endlessReader();
    const tracker = newTracker({ readChunk, getWaitMs: 20 });
    paths.set(SESSION, transcriptPath());
    tracker.applyHook(SESSION, createCall('toolu_1', '1', 'Known'));
    await nextTurns(1);

    tracker.repair(SESSION);
    const whileReading = await tracker.read(SESSION);
    control.isDone = true;
    const afterTheRead = await tracker.read(SESSION);

    expect(whileReading.stale).toBe(true);
    expect(rowsOf(whileReading)).toEqual(['1:pending:Known']);
    expect(afterTheRead.stale).toBeUndefined();
  });

  it('applies the hook folds that arrived during the read after it, never overwritten by it', async () => {
    const { control, readChunk } = endlessReader();
    const tracker = newTracker({ readChunk, getWaitMs: 20 });
    paths.set(SESSION, transcriptPath());
    tracker.repair(SESSION);
    await nextTurns(3);

    tracker.applyHook(SESSION, createCall('toolu_during', '1', 'Arrived during the read'));
    control.isDone = true;
    const todos = await tracker.read(SESSION);

    expect(rowsOf(todos)).toEqual(['1:pending:Arrived during the read']);
  });

  it('finishes a read that was in flight when its session closed, then keeps the final snapshot and nothing else', async () => {
    const { control, readChunk } = endlessReader();
    const tracker = newTracker({ readChunk, getWaitMs: 20 });
    paths.set(SESSION, transcriptPath());
    tracker.applyHook(SESSION, createCall('toolu_1', '1', 'Known'));
    tracker.repair(SESSION);
    await nextTurns(3);

    bus.emit({ type: 'session.closed', sessionId: SESSION });
    control.isDone = true;
    await nextTurns(20);
    clock.advance(EMIT_COALESCE_MS * 2);

    expect(rowsOf(tracker.get(SESSION))).toEqual(['1:pending:Known']);
    expect((tracker as unknown as { states: Map<string, unknown> }).states.size).toBe(0);
    expect(emitted.length).toBeLessThanOrEqual(1);
  });
});

describe('stop', () => {
  it('cancels every timer it armed', async () => {
    const tracker = newTracker();
    tracker.applyHook(SESSION, createCall('toolu_1', '1', 'One'));
    tracker.applyHook(SESSION, callWithoutPayload('toolu_2'));
    await nextTurns();
    expect(clock.pendingCount()).toBeGreaterThan(0);

    tracker.stop();

    expect(clock.pendingCount()).toBe(0);
  });
});
