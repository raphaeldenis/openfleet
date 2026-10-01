import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLOSED_SNAPSHOTS_KEPT, EMIT_COALESCE_MS, MAX_FOLD_BYTES, MAX_QUEUED_HOOKS, TODO_CHUNK_BYTES, type SessionTodos } from '@openfleet/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../events/eventBus.js';
import { recentLogLines } from '../logger.js';
import { narrowTodoHookCall, type TodoHookCall } from './todoHookCall.js';
import { FALLBACK_READ_DELAYS_MS, TodoTracker, type Schedule } from './todoTracker.js';
import { readTranscriptChunk as realReadTranscriptChunk, type readTranscriptChunk } from './transcriptChunkReader.js';

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

const newTracker = (options: { readChunk?: typeof readTranscriptChunk; getWaitMs?: number; closedSessionIds?: string[] } = {}) => {
  const { closedSessionIds = [], ...trackerOptions } = options;
  const sessions = { get: (id: string) => ({ createdAt: '2026-09-30T00:00:00.000Z', state: closedSessionIds.includes(id) ? 'closed' : 'idle' }), trustedTranscriptFileOf: (id: string) => paths.get(id) };
  const tracker = new TodoTracker({ sessions, bus, schedule: clock.schedule, now: () => NOW, ...trackerOptions });
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
  const SLOW_CHUNK_MS = 3;
  const spendMs = (durationMs: number) => { const until = performance.now() + durationMs; while (performance.now() < until); };

  /** A reader that reports a huge file it makes slow progress on, until told to finish. */
  const endlessReader = () => {
    const control = { isDone: false, reads: 0 };
    const readChunk: typeof readTranscriptChunk = (_path, request) => {
      control.reads += 1;
      if (control.isDone) return { kind: 'nothing' };
      spendMs(SLOW_CHUNK_MS);
      const nextOffset = request.offset + 10;
      return { kind: 'chunk', text: '', nextOffset, inode: 1, size: nextOffset + 1_000_000 };
    };
    return { control, readChunk };
  };

  it('answers within the wait with the last known list marked stale, then without the mark once the read finished', async () => {
    const { control, readChunk } = endlessReader();
    const tracker = newTracker({ readChunk, getWaitMs: 20 });
    paths.set(SESSION, transcriptPath());
    control.isDone = true;
    tracker.applyHook(SESSION, createCall('toolu_1', '1', 'Known'));
    await tracker.read(SESSION);
    control.isDone = false;

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

const statesOf = (tracker: TodoTracker) => (tracker as unknown as { states: Map<string, { idleWaiters: unknown[]; isRunning: boolean; isStale: boolean; fold: object }> }).states;
const warningsWith = (code: string) => recentLogLines().filter((line) => line.includes(code));
const updateHook = (toolUseId: string, taskId: string, status: string, success = true): TodoHookCall => narrowTodoHookCall({ tool_name: 'TaskUpdate', tool_use_id: toolUseId, tool_input: { taskId, status }, tool_response: { success, taskId } })!;

describe('a read of a transcript that keeps growing', () => {
  const runawayGuard = 500;

  it('stops at the size it had when it began, so the global read gate is released for another session', async () => {
    const reads: string[] = [];
    const readChunk: typeof readTranscriptChunk = (path, request) => {
      reads.push(path);
      if (reads.length > runawayGuard) throw new Error('runaway read');
      if (path !== '/growing/a.jsonl') return { kind: 'nothing' };
      return { kind: 'chunk', text: '', nextOffset: request.offset + TODO_CHUNK_BYTES, inode: 1, size: request.offset + 2 * TODO_CHUNK_BYTES };
    };
    const tracker = newTracker({ readChunk });
    paths.set('A', '/growing/a.jsonl');
    paths.set('B', '/other/b.jsonl');

    tracker.repair('A');
    await nextTurns(3);
    tracker.repair('B');
    await nextTurns(40);

    expect(reads).toContain('/other/b.jsonl');
    expect(reads.filter((path) => path === '/growing/a.jsonl').length).toBeLessThan(10);
  });

  it('reads at most MAX_FOLD_BYTES in one read, even of a file that was already that large', async () => {
    let chunkReads = 0;
    const readChunk: typeof readTranscriptChunk = (_path, request) => {
      chunkReads += 1;
      if (chunkReads > runawayGuard) throw new Error('runaway read');
      return { kind: 'chunk', text: '', nextOffset: request.offset + TODO_CHUNK_BYTES, inode: 1, size: 100 * MAX_FOLD_BYTES };
    };
    const tracker = newTracker({ readChunk });
    paths.set(SESSION, '/huge/a.jsonl');

    tracker.repair(SESSION);
    await tracker.read(SESSION);

    expect(chunkReads).toBeLessThanOrEqual(Math.ceil(MAX_FOLD_BYTES / TODO_CHUNK_BYTES));
  });
});

describe('the reads of two sessions', () => {
  it('never interleave their chunks: one global gate serialises them', async () => {
    const order: string[] = [];
    const readChunk: typeof readTranscriptChunk = (path, request) => {
      order.push(path);
      return { kind: 'chunk', text: '', nextOffset: request.offset + 10, inode: 1, size: 30 };
    };
    const tracker = newTracker({ readChunk });
    paths.set('A', '/a.jsonl');
    paths.set('B', '/b.jsonl');

    tracker.repair('A');
    tracker.repair('B');
    await nextTurns(30);

    expect(order).toEqual(['/a.jsonl', '/a.jsonl', '/a.jsonl', '/b.jsonl', '/b.jsonl', '/b.jsonl']);
  });
});

describe('a GET', () => {
  it('rebuilds the list of a session the tracker does not hold from its transcript, with no SessionStart before it', async () => {
    const tracker = newTracker();
    writeFileSync(transcriptPath(), `${transcriptCreate('toolu_1', '1', 'Survived the restart').join('\n')}\n`);
    paths.set(SESSION, transcriptPath());

    const todos = await tracker.read(SESSION);

    expect(rowsOf(todos)).toEqual(['1:pending:Survived the restart']);
  });

  it('holds no state for a closed session the tracker does not hold, however many times it is asked', async () => {
    const tracker = newTracker({ closedSessionIds: Array.from({ length: 1000 }, (_, index) => `closed-${index}`) });

    for (let index = 0; index < 1000; index += 1) await tracker.read(`closed-${index}`);

    expect(statesOf(tracker).size).toBe(0);
  });

  it('answers a closed session with the snapshot it kept, and an open session with nothing recorded adds no summary', async () => {
    const tracker = newTracker();
    tracker.applyHook('kept', createCall('toolu_1', '1', 'Kept at close'));
    await nextTurns();
    bus.emit({ type: 'session.closed', sessionId: 'kept' });

    const keptSnapshot = await tracker.read('kept');
    await tracker.read('only-asked');

    expect(rowsOf(keptSnapshot)).toEqual(['1:pending:Kept at close']);
    expect(tracker.summaries().map((summary) => summary.sessionId)).toEqual(['kept']);
  });
});

describe('a Stop or a SessionEnd', () => {
  it('reads nothing for a session that has no list', async () => {
    let reads = 0;
    const tracker = newTracker({ readChunk: (path, request) => { reads += 1; return realReadTranscriptChunk(path, request); } });
    paths.set(SESSION, transcriptPath());

    tracker.catchUp(SESSION);
    await nextTurns();

    expect(reads).toBe(0);
    expect(statesOf(tracker).size).toBe(0);
  });
});

describe('a hook queue that overflows with no transcript to restore it', () => {
  it('keeps the newest hook folds and drops the oldest', async () => {
    const tracker = newTracker();
    const total = MAX_QUEUED_HOOKS + 50;

    for (let index = 0; index < total; index += 1) tracker.applyHook(SESSION, createCall(`toolu_${index}`, String(index + 1), `Task ${index + 1}`));
    const todos = await tracker.read(SESSION);

    const oldestKept = total - MAX_QUEUED_HOOKS + 1;
    expect(rowsOf(todos)?.[0]).toBe(`${oldestKept}:pending:Task ${oldestKept}`);
  });
});

describe('a hook whose fold can not be located by id', () => {
  it('shows the row from the transcript when a todo hook came with no tool_use_id and its line was written late', async () => {
    const tracker = newTracker();
    writeFileSync(transcriptPath(), '');
    paths.set(SESSION, transcriptPath());
    tracker.readAfterHookWithoutPayload(SESSION);
    await nextTurns();

    appendFileSync(transcriptPath(), `${transcriptCreate('toolu_late', '1', 'Written late').join('\n')}\n`);
    clock.advance(FALLBACK_READ_DELAYS_MS[0]);
    const todos = await tracker.read(SESSION);

    expect(rowsOf(todos)).toEqual(['1:pending:Written late']);
  });
});

describe('a hook that arrives before the session ever read its transcript', () => {
  it('reads the history first, so the hook folds after it and the list never goes back to an older status', async () => {
    const tracker = newTracker();
    const history = [...transcriptCreate('toolu_c', '1', 'Ship'), ...transcriptCreate('toolu_c2', '2', 'Test')];
    const live = [assistantLine('toolu_u', 'TaskUpdate', { taskId: '1', status: 'completed' }), resultLine('toolu_u', { success: true, taskId: '1', statusChange: { to: 'completed' } })];
    writeFileSync(transcriptPath(), `${[...history, assistantLine('toolu_l', 'TaskList', {}), resultLine('toolu_l', { tasks: [{ id: '1', subject: 'Ship', status: 'pending' }, { id: '2', subject: 'Test', status: 'pending' }] }), ...live].join('\n')}\n`);
    paths.set(SESSION, transcriptPath());

    tracker.applyHook(SESSION, updateHook('toolu_u', '1', 'completed'));
    tracker.catchUp(SESSION);
    const todos = await tracker.read(SESSION);

    expect(rowsOf(todos)).toEqual(['1:completed:Ship', '2:pending:Test']);
  });
});

describe('a todo hook the CLI rejected', () => {
  it('does not read the transcript again and again for a TaskUpdate that failed (success false)', async () => {
    let reads = 0;
    const tracker = newTracker({ readChunk: (path, request) => { reads += 1; return realReadTranscriptChunk(path, request); } });
    writeFileSync(transcriptPath(), '');
    paths.set(SESSION, transcriptPath());

    tracker.applyHook(SESSION, updateHook('toolu_failed', '9', 'completed', false));
    await nextTurns();
    for (const delay of FALLBACK_READ_DELAYS_MS) { clock.advance(delay); await nextTurns(); }

    expect(reads).toBeLessThanOrEqual(1);
    expect(clock.pendingCount()).toBe(0);
  });
});

describe('a fallback that gave up without a transcript it trusts', () => {
  const giveUp = async (tracker: TodoTracker) => {
    tracker.applyHook(SESSION, callWithoutPayload('toolu_lost'));
    await nextTurns();
    for (const delay of FALLBACK_READ_DELAYS_MS) { clock.advance(delay); await nextTurns(); }
  };

  it('marks the list stale, and warns once with a code and the session id, never a text', async () => {
    const tracker = newTracker();

    await giveUp(tracker);
    const todos = await tracker.read(SESSION);

    const warnings = warningsWith('todo_transcript_unreadable');
    expect(todos.stale).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(SESSION);
  });

  it('keeps the list fresh when the transcript is readable, even if the call never showed up there', async () => {
    const tracker = newTracker();
    writeFileSync(transcriptPath(), '');
    paths.set(SESSION, transcriptPath());

    await giveUp(tracker);

    expect((await tracker.read(SESSION)).stale).toBeUndefined();
  });
});

describe('a fault in a timer callback', () => {
  it('marks the list stale and warns once with a code, instead of throwing out of the timer', async () => {
    const tracker = newTracker();
    tracker.applyHook(SESSION, createCall('toolu_1', '1', 'One'));
    await nextTurns();
    Object.defineProperty(statesOf(tracker).get(SESSION)!.fold, 'tasks', { get: () => { throw new Error('boom SECRET-TEXT'); } });

    expect(() => clock.advance(EMIT_COALESCE_MS)).not.toThrow();

    expect(statesOf(tracker).get(SESSION)!.isStale).toBe(true);
    const warnings = warningsWith('todo_emit_failed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain('SECRET-TEXT');
  });
});

describe('a listener that throws', () => {
  it('is logged once with a code and the session id, and the other listeners still hear the change', async () => {
    const tracker = newTracker();
    tracker.onUpdate(() => { throw new Error('boom SECRET-TEXT'); });

    tracker.applyHook(SESSION, createCall('toolu_1', '1', 'One'));
    await nextTurns();
    clock.advance(EMIT_COALESCE_MS);
    tracker.applyHook(SESSION, createCall('toolu_2', '2', 'Two'));
    await nextTurns();
    clock.advance(EMIT_COALESCE_MS);

    const warnings = warningsWith('todo_listener_failed');
    expect(emitted).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain('SECRET-TEXT');
  });
});

describe('the GETs that timed out', () => {
  it('leave no waiter behind once they answered', async () => {
    const tracker = newTracker({ getWaitMs: 1 });
    tracker.applyHook(SESSION, createCall('toolu_1', '1', 'One'));
    await nextTurns();
    statesOf(tracker).get(SESSION)!.isRunning = true;

    for (let asked = 0; asked < 20; asked += 1) await tracker.read(SESSION);

    expect(statesOf(tracker).get(SESSION)!.idleWaiters).toHaveLength(0);
  });
});

describe('after a resume the rows rebuilt from the old transcript are unverified until a live call confirms them', () => {
  it('marks the repaired rows unverified, and clears the marker of the id a live create replaces', async () => {
    const tracker = newTracker();
    paths.set(SESSION, transcriptPath('resumed.jsonl'));
    writeFileSync(transcriptPath('resumed.jsonl'), `${[...transcriptCreate('toolu_h1', '1', 'Old one'), ...transcriptCreate('toolu_h2', '2', 'Old two')].join('\n')}\n`);

    tracker.repair(SESSION);
    await nextTurns();
    const afterRepair = tracker.get(SESSION);
    tracker.applyHook(SESSION, createCall('toolu_live', '1', 'New one'));
    await nextTurns();

    expect(afterRepair?.items.map((item) => item.unverified)).toEqual([true, true]);
    expect(tracker.get(SESSION)?.items).toEqual([
      { id: '1', content: 'New one', status: 'pending' },
      { id: '2', content: 'Old two', status: 'pending', unverified: true },
    ]);
  });

  it('does not mark a row the hooks created in a session that never had history', async () => {
    const tracker = newTracker();

    tracker.applyHook(SESSION, createCall('toolu_1', '1', 'Fresh'));
    await nextTurns();

    expect(tracker.get(SESSION)?.items).toEqual([{ id: '1', content: 'Fresh', status: 'pending' }]);
  });
});
