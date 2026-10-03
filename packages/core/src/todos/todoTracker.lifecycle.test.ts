import { EMIT_COALESCE_MS, type SessionTodos } from '@openfleet/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../events/eventBus.js';
import { narrowTodoHookCall, type TodoHookCall } from './todoHookCall.js';
import { TodoTracker, type Schedule } from './todoTracker.js';
import type { readTranscriptChunk } from './transcriptChunkReader.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const SESSION = 'session-1';
const TRANSCRIPT = '/injected/session.jsonl';
const FIRST_FALLBACK_DELAY_MS = 150;

type ClockKind = { name: string; honorsCancel: boolean };
const CLOCKS: ClockKind[] = [
  { name: 'timers cancelled at close never fire', honorsCancel: true },
  { name: 'timers that outlive their cancellation still cannot touch the session', honorsCancel: false },
];

const fakeClock = ({ honorsCancel }: { honorsCancel: boolean }) => {
  const timers: { run: () => void; at: number; isCancelled: boolean; hasFired: boolean }[] = [];
  let now = 0;
  const schedule: Schedule = (run, delayMs) => {
    const timer = { run, at: now + delayMs, isCancelled: false, hasFired: false };
    timers.push(timer);
    return () => { if (honorsCancel) timer.isCancelled = true; };
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

const nextTurns = async (count = 40) => { for (let turn = 0; turn < count; turn += 1) await new Promise((resolve) => setImmediate(resolve)); };

const createCall = (toolUseId: string, taskId: string, subject: string): TodoHookCall => narrowTodoHookCall({ tool_name: 'TaskCreate', tool_use_id: toolUseId, tool_input: { subject }, tool_response: { task: { id: taskId, subject } } })!;
const updateCall = (toolUseId: string, taskId: string, input: object, response: object): TodoHookCall => narrowTodoHookCall({ tool_name: 'TaskUpdate', tool_use_id: toolUseId, tool_input: { taskId, ...input }, tool_response: { taskId, ...response } })!;
const completeCall = (toolUseId: string, taskId: string) => updateCall(toolUseId, taskId, { status: 'completed' }, { success: true });
const rejectedUpdateCall = (toolUseId: string, taskId: string) => updateCall(toolUseId, taskId, {}, { success: false });
const callWithoutPayload = (toolUseId: string): TodoHookCall => narrowTodoHookCall({ tool_name: 'TaskCreate', tool_use_id: toolUseId })!;

const transcriptOf = (toolUseId: string, name: string, input: unknown, toolUseResult: unknown) => [
  { type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name, input }] } },
  { type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] }, toolUseResult },
].map((record) => JSON.stringify(record)).join('\n') + '\n';
const historyCreate = (toolUseId: string, taskId: string, subject: string) => transcriptOf(toolUseId, 'TaskCreate', { subject }, { task: { id: taskId, subject } });
const historyComplete = (toolUseId: string, taskId: string) => transcriptOf(toolUseId, 'TaskUpdate', { taskId, status: 'completed' }, { success: true, taskId });
const historyList = (toolUseId: string, tasks: object[]) => transcriptOf(toolUseId, 'TaskList', {}, { tasks });

const chunkOf = (text: string, inode = 1): ReturnType<typeof readTranscriptChunk> => ({ kind: 'chunk', text, nextOffset: text.length, size: text.length, inode });

let bus: EventBus;
let path: string | undefined;
let emitted: SessionTodos[];

beforeEach(() => {
  bus = new EventBus();
  path = TRANSCRIPT;
  emitted = [];
});

const newTracker = (options: { readChunk?: typeof readTranscriptChunk; clock?: ReturnType<typeof fakeClock> } = {}) => {
  const clock = options.clock ?? fakeClock({ honorsCancel: true });
  const sessions = { get: () => ({ createdAt: '2026-09-30T00:00:00.000Z', state: 'idle' }), trustedTranscriptFileOf: () => path };
  const tracker = new TodoTracker({ sessions, bus, schedule: clock.schedule, now: () => NOW, readChunk: options.readChunk ?? (() => ({ kind: 'nothing' })) });
  tracker.onUpdate((todos) => emitted.push(todos));
  return { tracker, clock };
};
const stateCountOf = (tracker: TodoTracker) => (tracker as unknown as { states: Map<string, unknown> }).states.size;
const contentsOf = (todos: SessionTodos | undefined) => todos?.items.map((item) => item.content);
const closeSession = () => bus.emit({ type: 'session.closed', sessionId: SESSION });
const reopenSession = () => bus.emit({ type: 'session.reopened', sessionId: SESSION });

describe.each(CLOCKS)('F1 a callback that survives the close ($name)', ({ honorsCancel }) => {
  it('never deletes or replaces the live state of a reopened session, and emits no old list', async () => {
    const { tracker, clock } = newTracker({ clock: fakeClock({ honorsCancel }) });
    tracker.applyHook(SESSION, createCall('old', '1', 'Before close'));
    tracker.applyHook(SESSION, callWithoutPayload('missing'));
    await nextTurns();
    closeSession();
    reopenSession();
    tracker.applyHook(SESSION, createCall('new', '2', 'After reopen'));
    await nextTurns();
    const eventsBeforeTheOldTimer = emitted.length;

    clock.advance(FIRST_FALLBACK_DELAY_MS);
    await nextTurns();

    expect(stateCountOf(tracker)).toBe(1);
    expect(contentsOf(tracker.get(SESSION))).toEqual(['After reopen']);
    expect(emitted.slice(eventsBeforeTheOldTimer).flatMap(contentsOf)).not.toContain('Before close');
  });

  it('gives the reopened session its own state while the read of the closing one is still in flight', async () => {
    let isDone = false;
    const slowReader: typeof readTranscriptChunk = (_path, request) => {
      if (isDone) return { kind: 'nothing' };
      const until = performance.now() + 3;
      while (performance.now() < until);
      return { kind: 'chunk', text: '', nextOffset: request.offset + 10, inode: 1, size: request.offset + 1_000_000 };
    };
    const { tracker, clock } = newTracker({ readChunk: slowReader, clock: fakeClock({ honorsCancel }) });
    tracker.applyHook(SESSION, createCall('old', '1', 'Before close'));
    await nextTurns(3);

    closeSession();
    reopenSession();
    tracker.applyHook(SESSION, createCall('new', '2', 'After reopen'));
    isDone = true;
    await nextTurns();
    clock.advance(EMIT_COALESCE_MS * 2);

    expect(stateCountOf(tracker)).toBe(1);
    expect(contentsOf(tracker.get(SESSION))).toEqual(['After reopen']);
  });

  it('keeps the final snapshot of a closed session unchanged when a pending fallback would read again (P4)', async () => {
    let isTranscriptAvailable = false;
    let readCount = 0;
    const reader: typeof readTranscriptChunk = () => {
      readCount += 1;
      return isTranscriptAvailable ? chunkOf(historyCreate('missing', '1', 'Late task')) : { kind: 'nothing' };
    };
    const { tracker, clock } = newTracker({ readChunk: reader, clock: fakeClock({ honorsCancel }) });
    tracker.applyHook(SESSION, callWithoutPayload('missing'));
    await nextTurns();
    closeSession();
    const finalSnapshot = tracker.get(SESSION);
    const readsAtTheClose = readCount;
    isTranscriptAvailable = true;

    clock.advance(FIRST_FALLBACK_DELAY_MS);
    await nextTurns();

    expect(readCount).toBe(readsAtTheClose);
    expect(tracker.get(SESSION)).toEqual(finalSnapshot);
    expect(tracker.get(SESSION)?.counts.total).toBe(0);
  });
});

describe('F1 the timers of a closed session', () => {
  it('are cancelled at the close: the fallback and the pending emit leave nothing armed', async () => {
    const { tracker, clock } = newTracker();
    tracker.applyHook(SESSION, createCall('old', '1', 'Before close'));
    tracker.applyHook(SESSION, callWithoutPayload('missing'));
    await nextTurns();
    expect(clock.pendingCount()).toBeGreaterThan(0);

    closeSession();

    expect(clock.pendingCount()).toBe(0);
  });
});

describe('F2 a first repair that could not read the history', () => {
  const history = historyCreate('oldCreate', '1', 'Ship') + historyList('oldList', [{ id: '1', subject: 'Ship', status: 'pending' }]) + historyComplete('liveUpdate', '1');

  it('keeps a live completion when the history appears later with an older pending list (P2)', async () => {
    const { tracker } = newTracker({ readChunk: () => chunkOf(history) });
    path = undefined;
    tracker.applyHook(SESSION, completeCall('liveUpdate', '1'));
    await nextTurns();
    expect(tracker.get(SESSION)?.items[0]?.status).toBe('completed');

    path = TRANSCRIPT;
    tracker.catchUp(SESSION);
    await nextTurns();

    expect(tracker.get(SESSION)?.items[0]?.status).toBe('completed');
  });

  it('keeps a live completion when the first reader threw', async () => {
    let shouldThrow = true;
    const reader: typeof readTranscriptChunk = () => {
      if (shouldThrow) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return chunkOf(history);
    };
    const { tracker } = newTracker({ readChunk: reader });
    tracker.applyHook(SESSION, completeCall('liveUpdate', '1'));
    await nextTurns();

    shouldThrow = false;
    tracker.catchUp(SESSION);
    await nextTurns();

    expect(tracker.get(SESSION)?.items[0]?.status).toBe('completed');
  });

  it('replays a live completion the history does not contain after the history', async () => {
    const historyWithoutTheUpdate = historyCreate('oldCreate', '1', 'Ship') + historyList('oldList', [{ id: '1', subject: 'Ship', status: 'pending' }]);
    const { tracker } = newTracker({ readChunk: () => chunkOf(historyWithoutTheUpdate) });
    path = undefined;
    tracker.applyHook(SESSION, completeCall('liveUpdate', '1'));
    await nextTurns();

    path = TRANSCRIPT;
    tracker.catchUp(SESSION);
    await nextTurns();

    const [row] = tracker.get(SESSION)!.items;
    expect(row).toMatchObject({ id: '1', content: 'Ship', status: 'completed' });
    expect(row?.unverified).toBeUndefined();
  });

  it('keeps a live row as verified when the history that appears later is empty', async () => {
    const { tracker } = newTracker();
    path = undefined;
    tracker.applyHook(SESSION, createCall('live', '1', 'Live task'));
    await nextTurns();

    path = TRANSCRIPT;
    tracker.catchUp(SESSION);
    await nextTurns();

    expect(tracker.get(SESSION)?.items[0]?.unverified).toBeUndefined();
  });
});

describe('F3 the live hook of a call the first read already folded', () => {
  it('confirms the created row without replaying it (P1)', async () => {
    const { tracker } = newTracker({ readChunk: () => chunkOf(historyCreate('live', '1', 'Live task')) });

    tracker.applyHook(SESSION, createCall('live', '1', 'Live task'));
    await nextTurns();

    const { items } = tracker.get(SESSION)!;
    expect(items).toHaveLength(1);
    expect(items[0]?.unverified).toBeUndefined();
  });

  it('confirms only the rows the live hooks name', async () => {
    const history = historyCreate('older', '1', 'Older task') + historyCreate('live', '2', 'Live task');
    const { tracker } = newTracker({ readChunk: () => chunkOf(history) });

    tracker.applyHook(SESSION, createCall('live', '2', 'Live task'));
    await nextTurns();

    const unverifiedOfId = Object.fromEntries(tracker.get(SESSION)!.items.map((item) => [item.id, item.unverified]));
    expect(unverifiedOfId).toEqual({ '1': true, '2': undefined });
  });

  it('confirms the updated row without replaying the update', async () => {
    const history = historyCreate('create', '1', 'Task') + historyComplete('live', '1');
    const { tracker } = newTracker({ readChunk: () => chunkOf(history) });

    tracker.applyHook(SESSION, completeCall('live', '1'));
    await nextTurns();

    expect(tracker.get(SESSION)!.items[0]).toMatchObject({ status: 'completed' });
    expect(tracker.get(SESSION)!.items[0]?.unverified).toBeUndefined();
  });

  it('marks nothing unverified for an ordinary first task the transcript does not hold yet', async () => {
    const { tracker } = newTracker();

    tracker.applyHook(SESSION, createCall('live', '1', 'Fresh first task'));
    await nextTurns();

    expect(tracker.get(SESSION)?.items[0]?.unverified).toBeUndefined();
  });
});

describe('F4 a history rebuilt after the file was replaced', () => {
  it('keeps its rows unverified until a live call confirms them, so a rejected update removes the ghost (P5)', async () => {
    const history = historyCreate('old', '1', 'Ghost');
    let isReplaced = false;
    const reader: typeof readTranscriptChunk = (_path, request) => (isReplaced && request.inode === 1 ? { kind: 'reset' } : chunkOf(history, isReplaced ? 2 : 1));
    const { tracker } = newTracker({ readChunk: reader });
    tracker.repair(SESSION);
    await nextTurns();
    expect(tracker.get(SESSION)?.items[0]?.unverified).toBe(true);

    isReplaced = true;
    tracker.catchUp(SESSION);
    await nextTurns();
    const rowsAfterTheRebuild = tracker.get(SESSION)!.items;
    tracker.applyHook(SESSION, rejectedUpdateCall('failed', '1'));
    await nextTurns();

    expect(rowsAfterTheRebuild[0]?.unverified).toBe(true);
    expect(tracker.get(SESSION)?.counts.total).toBe(0);
  });
});
