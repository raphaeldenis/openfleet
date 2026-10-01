import { readFileSync } from 'node:fs';
import { MAX_TODO_ITEMS, MAX_TODO_TEXT, MAX_TRACKED_TASKS, SEEN_CALLS_KEPT, type TodoToolName } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { applyCompletedCall, createTodoFold, foldHookPayload, foldTranscriptText, markRowsUnverified, normalisedTodoText, snapshotOf, type TodoFold } from './todoFold.js';
import { narrowTodoHookCall, type TodoHookCall } from './todoHookCall.js';

const NOW = new Date('2026-09-30T17:00:00.000Z');
const fixtureLines = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8').split('\n').filter(Boolean);
const interactive = fixtureLines('interactive-1.jsonl');
const realHookBodies = fixtureLines('hook-post-tool-use-1.jsonl').map((line) => JSON.parse(line) as Record<string, unknown>);

// Interactive sample, by 0-based record: 0–9 run A (same run as the four hook bodies), 10–29 run B, 30–49 run B after /clear (new transcript file, same daemon session).
const linesOf = (first: number, last: number) => interactive.slice(first, last + 1);

const newFold = (): TodoFold => createTodoFold({ now: () => NOW });
const foldLines = (fold: TodoFold, lines: string[]) => foldTranscriptText(fold, `${lines.join('\n')}\n`);
const foldedFrom = (...lines: string[][]): TodoFold => {
  const fold = newFold();
  lines.forEach((group) => foldLines(fold, group));
  return fold;
};
const snapshot = (fold: TodoFold) => snapshotOf(fold, 'session-1');
const rowsOf = (fold: TodoFold) => snapshot(fold).items.map((item) => `${item.id}:${item.status}:${item.content}`);

const hookCall = (name: string, toolUseId: string, input: unknown, response: unknown): TodoHookCall => {
  const call = narrowTodoHookCall({ tool_name: name, tool_use_id: toolUseId, tool_input: input, tool_response: response });
  if (!call) throw new Error(`the test call ${name} did not narrow`);
  return call;
};
const hookCallOfBody = (body: Record<string, unknown>) => hookCall(String(body.tool_name), String(body.tool_use_id), body.tool_input, body.tool_response);

/** Pairs each todo tool_use of the given transcript records with its result: the call as the hook would have delivered it. */
const callsDeliveredByHookFrom = (lines: string[]): TodoHookCall[] => {
  const records = lines.map((line) => JSON.parse(line));
  const blocks = records.flatMap((record) => (Array.isArray(record.message?.content) ? record.message.content : []));
  const uses = blocks.filter((block: { type: string; name: string }) => block.type === 'tool_use' && block.name !== 'ToolSearch');
  return uses.map((use: { id: string; name: string; input: unknown }) => {
    const result = records.find((record) => record.message?.content?.some?.((block: { tool_use_id?: string }) => block.tool_use_id === use.id));
    return hookCall(use.name, use.id, use.input, result.toolUseResult);
  });
};

const assistantLine = (id: string, name: string, input: unknown, extra: object = {}) =>
  JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: '2026-09-30T16:30:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, ...extra });
const resultLine = (id: string, toolUseResult: unknown, options: { isError?: boolean; content?: string } = {}) =>
  JSON.stringify({
    type: 'user',
    isSidechain: false,
    timestamp: '2026-09-30T16:30:01.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: options.content ?? 'ok', ...(options.isError ? { is_error: true } : {}) }] },
    ...(toolUseResult === undefined ? {} : { toolUseResult }),
  });
const createLines = (id: string, taskId: string, subject: string) => [assistantLine(id, 'TaskCreate', { subject }), resultLine(id, { task: { id: taskId, subject } })];
const updateLines = (id: string, taskId: string, status: string) => [
  assistantLine(id, 'TaskUpdate', { taskId, status }),
  resultLine(id, { success: true, taskId, updatedFields: ['status'], statusChange: { from: 'pending', to: status } }),
];

describe('the list a session planned, folded from the real interactive transcript', () => {
  it('shows the three tasks of run A with the status the agent left them in', () => {
    const fold = foldedFrom(linesOf(0, 9));

    expect(rowsOf(fold)).toEqual(['1:completed:Review user feedback', '2:pending:Update documentation', '3:pending:Run performance tests']);
    expect(snapshot(fold)).toMatchObject({ source: 'task_tools', counts: { total: 3, completed: 1, inProgress: 0, pending: 2 }, omitted: 0 });
    expect(snapshot(fold).incomplete).toBeUndefined();
  });

  it('stamps the snapshot with the timestamp of the transcript line that changed it last', () => {
    const fold = foldedFrom(linesOf(0, 9));

    expect(snapshot(fold).updatedAt).toBe(JSON.parse(interactive[9]!).timestamp);
  });

  it('shows a task moving through in_progress to completed and a deleted task disappearing (run B)', () => {
    const afterStart = foldedFrom(linesOf(10, 19));
    const afterTheWholeRun = foldedFrom(linesOf(10, 29));

    expect(rowsOf(afterStart)).toEqual(['1:in_progress:Review pull request', '2:pending:Update documentation', '3:pending:Fix bug in auth module']);
    expect(rowsOf(afterTheWholeRun)).toEqual(['1:completed:Review pull request', '2:pending:Update documentation']);
  });

  it('keeps the list after /clear: the new transcript file has no TaskCreate of the earlier tasks, the ids keep counting', () => {
    const fold = foldedFrom(linesOf(10, 29), linesOf(30, 49));

    expect(rowsOf(fold)).toEqual([
      '1:completed:Review pull request',
      '2:in_progress:Update documentation',
      '4:completed:Check ids after clear',
      '5:pending:Timing A',
      '6:pending:Timing B',
    ]);
    expect(snapshot(fold).incomplete).toBeUndefined();
  });

  it('rebuilds the same list from the post-/clear file alone, because its TaskList answers with every task', () => {
    const fromBothFiles = foldedFrom(linesOf(10, 29), linesOf(30, 49));
    const fromTheSecondFileOnly = foldedFrom(linesOf(30, 49));

    expect(rowsOf(fromTheSecondFileOnly)).toEqual(rowsOf(fromBothFiles));
  });

  it('still shows the list after a compaction marker in the file', () => {
    const compactBoundary = JSON.stringify({ type: 'system', subtype: 'compact_boundary', isSidechain: false });

    const fold = foldedFrom(linesOf(10, 17), [compactBoundary], linesOf(18, 29));

    expect(rowsOf(fold)).toEqual(['1:completed:Review pull request', '2:pending:Update documentation']);
  });

  it.each([
    ['in the order the CLI wrote them', [39, 40, 41, 42]],
    ['with the TaskList result written before the TaskUpdate result', [39, 40, 42, 41]],
  ])('matches each result to its call by id when a TaskUpdate and a TaskList return out of order (%s)', (_order, recordNumbers) => {
    const fold = foldedFrom(linesOf(10, 29), linesOf(30, 38), recordNumbers.map((number) => interactive[number]!));

    expect(rowsOf(fold)).toEqual(['1:completed:Review pull request', '2:in_progress:Update documentation', '4:pending:Check ids after clear']);
  });

  it('shows a row "Task #2" flagged unnamed, and the snapshot incomplete, when an update names an id the fold never saw', () => {
    const fold = foldedFrom([interactive[39]!, interactive[41]!]);

    expect(snapshot(fold).items).toEqual([{ id: '2', content: 'Task #2', status: 'in_progress', unnamed: true }]);
    expect(snapshot(fold).incomplete).toBe(true);
    expect(snapshot(fold).counts).toMatchObject({ total: 1, inProgress: 1 });
  });

  it('names the placeholder and clears incomplete when the next TaskList answers with the task', () => {
    const fold = foldedFrom([interactive[39]!, interactive[41]!], [interactive[40]!, interactive[42]!]);

    expect(rowsOf(fold)).toEqual(['1:completed:Review pull request', '2:in_progress:Update documentation', '4:pending:Check ids after clear']);
    expect(snapshot(fold).incomplete).toBeUndefined();
  });

  it('names the placeholder and clears incomplete when a TaskCreate for that id arrives, keeping the status the update gave it', () => {
    const fold = newFold();
    foldHookPayload(fold, hookCall('TaskUpdate', 'u1', { taskId: '9', status: 'in_progress' }, { success: true, taskId: '9' }));

    foldHookPayload(fold, hookCall('TaskCreate', 'c1', { subject: 'Nine' }, { task: { id: '9', subject: 'Nine' } }));

    expect(snapshot(fold).items).toEqual([{ id: '9', content: 'Nine', status: 'in_progress' }]);
    expect(snapshot(fold).incomplete).toBeUndefined();
  });

  it('does not flag the snapshot incomplete when the update itself carries a subject', () => {
    const fold = newFold();

    foldHookPayload(fold, hookCall('TaskUpdate', 'u1', { taskId: '9', subject: 'Named by the update' }, { success: true, taskId: '9' }));

    expect(snapshot(fold).items).toEqual([{ id: '9', content: 'Named by the update', status: 'pending' }]);
    expect(snapshot(fold).incomplete).toBeUndefined();
  });
});

describe('the list folded from the real hook bodies', () => {
  it('shows the same three tasks as the transcript of the same run, with no transcript line read', () => {
    const fold = newFold();

    realHookBodies.forEach((body) => foldHookPayload(fold, hookCallOfBody(body)));

    expect(rowsOf(fold)).toEqual(rowsOf(foldedFrom(linesOf(0, 9))));
  });

  it('stamps a hook call with the daemon clock: the hook carries no timestamp', () => {
    const fold = newFold();

    foldHookPayload(fold, hookCallOfBody(realHookBodies[0]!));

    expect(snapshot(fold).updatedAt).toBe(NOW.toISOString());
  });
});

describe('a call seen by both sources folds once, whichever arrives first', () => {
  it('ignores the transcript lines of a run the hook already delivered (hook first)', () => {
    const hookOnly = newFold();
    const hookThenTranscript = newFold();
    realHookBodies.forEach((body) => foldHookPayload(hookOnly, hookCallOfBody(body)));
    realHookBodies.forEach((body) => foldHookPayload(hookThenTranscript, hookCallOfBody(body)));

    foldLines(hookThenTranscript, linesOf(0, 9));

    expect(snapshot(hookThenTranscript)).toEqual(snapshot(hookOnly));
  });

  it('ignores the late hook of a run the transcript already delivered (transcript first)', () => {
    const transcriptOnly = foldedFrom(linesOf(0, 9));
    const transcriptThenHook = foldedFrom(linesOf(0, 9));

    realHookBodies.forEach((body) => foldHookPayload(transcriptThenHook, hookCallOfBody(body)));

    expect(snapshot(transcriptThenHook)).toEqual(snapshot(transcriptOnly));
  });

  it('does not bring a deleted task back nor revert a status when a hook arrives late for an older call', () => {
    const fold = foldedFrom(linesOf(10, 23));
    const hooksOfTheThreeCreatesAndTheFirstUpdate = callsDeliveredByHookFrom(linesOf(10, 23)).slice(0, 4);

    hooksOfTheThreeCreatesAndTheFirstUpdate.forEach((call) => foldHookPayload(fold, call));

    expect(rowsOf(fold)).toEqual(['1:completed:Review pull request', '2:pending:Update documentation']);
  });

  it('applies a status once when the same tool_use_id is delivered twice by the hook and twice by the transcript', () => {
    const fold = newFold();
    const completion = hookCall('TaskUpdate', 'u-completed', { taskId: '1', status: 'completed' }, { success: true, taskId: '1' });
    const reopening = hookCall('TaskUpdate', 'u-reopened', { taskId: '1', status: 'pending' }, { success: true, taskId: '1' });
    foldHookPayload(fold, hookCall('TaskCreate', 'c1', { subject: 'A' }, { task: { id: '1', subject: 'A' } }));
    foldHookPayload(fold, completion);
    foldHookPayload(fold, reopening);

    foldHookPayload(fold, completion);
    foldLines(fold, updateLines('u-completed', '1', 'completed'));
    foldLines(fold, updateLines('u-completed', '1', 'completed'));

    expect(rowsOf(fold)).toEqual(['1:pending:A']);
  });

  it('still folds a call from the transcript when the hook delivered it without a usable result: a dropped call is not remembered', () => {
    const fold = newFold();
    foldHookPayload(fold, hookCall('TaskCreate', 'c1', { subject: 'A' }, { task: { subject: 'A' } }));

    foldLines(fold, createLines('c1', '1', 'A'));

    expect(rowsOf(fold)).toEqual(['1:pending:A']);
  });

  it('keeps the first delivery when the hook and the transcript disagree about the same call', () => {
    const fold = newFold();
    foldHookPayload(fold, hookCall('TaskCreate', 'c1', { subject: 'From the hook' }, { task: { id: '1', subject: 'From the hook' } }));

    foldLines(fold, createLines('c1', '1', 'From the transcript'));

    expect(rowsOf(fold)).toEqual(['1:pending:From the hook']);
  });

  it(`remembers the last ${SEEN_CALLS_KEPT} calls and forgets older ones, so memory stays bounded`, () => {
    const fold = newFold();
    const reopenFirstTask = (toolUseId: string) => foldHookPayload(fold, hookCall('TaskUpdate', toolUseId, { taskId: '1', status: 'pending' }, { success: true, taskId: '1' }));
    const completeFirstTask = hookCall('TaskUpdate', 'oldest', { taskId: '1', status: 'completed' }, { success: true, taskId: '1' });
    foldHookPayload(fold, completeFirstTask);
    for (let call = 1; call < SEEN_CALLS_KEPT; call += 1) reopenFirstTask(`filler-${call}`);

    foldHookPayload(fold, completeFirstTask);
    expect(rowsOf(fold)).toEqual(['1:pending:Task #1']);

    reopenFirstTask('one-more');
    foldHookPayload(fold, completeFirstTask);
    expect(rowsOf(fold)).toEqual(['1:completed:Task #1']);
  });
});

describe('what each tool does to the list', () => {
  it('replaces the whole list with a TodoWrite list, in the order given (synthetic fixture)', () => {
    const afterFirstWrite = foldedFrom(fixtureLines('todowrite-synthetic.jsonl').slice(0, 3));
    const afterSecondWrite = foldedFrom(fixtureLines('todowrite-synthetic.jsonl'));

    expect(rowsOf(afterFirstWrite)).toEqual(['0:completed:Write the spec', '1:in_progress:Write the code', '2:pending:Ship it']);
    expect(rowsOf(afterSecondWrite)).toEqual(['0:completed:Write the spec', '1:completed:Write the code', '2:in_progress:Ship it', '3:pending:Celebrate']);
    expect(snapshot(afterSecondWrite).source).toBe('todo_write');
    expect(snapshot(afterSecondWrite).items[2]?.activeForm).toBe('Shipping it');
  });

  it('reads as nothing recorded before any call', () => {
    expect(snapshot(newFold())).toEqual({ sessionId: 'session-1', items: [], counts: { total: 0, completed: 0, inProgress: 0, pending: 0 }, omitted: 0, source: null, updatedAt: null });
  });

  it('reads TaskList as a full snapshot: a row the snapshot omits disappears, a status the fold missed is corrected', () => {
    const fold = foldedFrom(createLines('c1', '1', 'A'), createLines('c2', '2', 'B'), createLines('c3', '3', 'C'));

    foldHookPayload(fold, hookCall('TaskList', 'l1', {}, { tasks: [{ id: '1', subject: 'A', status: 'completed' }, { id: '3', subject: 'C', status: 'in_progress' }] }));

    expect(rowsOf(fold)).toEqual(['1:completed:A', '3:in_progress:C']);
  });

  it('empties the list on an empty TaskList', () => {
    const fold = foldedFrom(createLines('c1', '1', 'A'));

    foldHookPayload(fold, hookCall('TaskList', 'l1', {}, { tasks: [] }));

    expect(snapshot(fold)).toMatchObject({ items: [], counts: { total: 0 }, source: 'task_tools' });
  });

  it('keeps the activeForm of a row across a TaskList, which does not carry it', () => {
    const fold = newFold();
    foldHookPayload(fold, hookCall('TaskCreate', 'c1', { subject: 'A', activeForm: 'Doing A' }, { task: { id: '1', subject: 'A' } }));

    foldHookPayload(fold, hookCall('TaskList', 'l1', {}, { tasks: [{ id: '1', subject: 'A', status: 'in_progress' }] }));

    expect(snapshot(fold).items).toEqual([{ id: '1', content: 'A', status: 'in_progress', activeForm: 'Doing A' }]);
  });

  it('reads an unknown status in a TaskList entry as pending and skips an entry without id or subject', () => {
    const fold = newFold();

    foldHookPayload(fold, hookCall('TaskList', 'l1', {}, { tasks: [{ id: '1', subject: 'A', status: 'blocked' }, { subject: 'no id' }, { id: '3' }] }));

    expect(rowsOf(fold)).toEqual(['1:pending:A']);
  });

  it('removes a deleted task and ignores a deleted update for an id it never saw, without a placeholder', () => {
    const fold = foldedFrom(createLines('c1', '1', 'A'));

    foldHookPayload(fold, hookCall('TaskUpdate', 'u1', { taskId: '1', status: 'deleted' }, { success: true, taskId: '1' }));
    foldHookPayload(fold, hookCall('TaskUpdate', 'u2', { taskId: '42', status: 'deleted' }, { success: true, taskId: '42' }));

    expect(snapshot(fold)).toMatchObject({ items: [], counts: { total: 0 } });
    expect(snapshot(fold).incomplete).toBeUndefined();
  });

  it('reads the new status from the result when the input carries none', () => {
    const fold = foldedFrom(createLines('c1', '1', 'A'));

    foldHookPayload(fold, hookCall('TaskUpdate', 'u1', { taskId: '1' }, { success: true, taskId: '1', statusChange: { from: 'pending', to: 'in_progress' } }));

    expect(rowsOf(fold)).toEqual(['1:in_progress:A']);
  });

  it.each([['COMPLETED'], [''], ['blocked']])('leaves the row as it was when the status is %j', (status) => {
    const fold = foldedFrom(createLines('c1', '1', 'A'), updateLines('u0', '1', 'in_progress'));

    foldHookPayload(fold, hookCall('TaskUpdate', 'u1', { taskId: '1', status }, { success: true, taskId: '1' }));

    expect(rowsOf(fold)).toEqual(['1:in_progress:A']);
  });

  it.each([[null], [{ done: true }], [['completed']], [42]])('leaves the row as it was when the status is %j', (status) => {
    const fold = foldedFrom(createLines('c1', '1', 'A'));

    applyCompletedCall(fold, { toolUseId: 'u1', name: 'TaskUpdate', input: { status } as never, response: { success: true, taskId: '1' } });

    expect(rowsOf(fold)).toEqual(['1:pending:A']);
  });

  it('renames a row when the update carries a subject or an activeForm', () => {
    const fold = foldedFrom(createLines('c1', '1', 'A'));

    foldHookPayload(fold, hookCall('TaskUpdate', 'u1', { taskId: '1', subject: 'Renamed', activeForm: 'Renaming' }, { success: true, taskId: '1' }));

    expect(snapshot(fold).items).toEqual([{ id: '1', content: 'Renamed', status: 'pending', activeForm: 'Renaming' }]);
  });

  it('keeps the creation order of the ids', () => {
    const fold = foldedFrom(createLines('c2', '2', 'second'), createLines('c1', '1', 'first'), updateLines('u1', '2', 'completed'));

    expect(rowsOf(fold)).toEqual(['2:completed:second', '1:pending:first']);
  });
});

describe('calls that did not succeed leave no trace', () => {
  it('adds no row for a TaskCreate whose result is an error', () => {
    const fold = foldedFrom([assistantLine('c1', 'TaskCreate', { subject: 'A' }), resultLine('c1', { task: { id: '1', subject: 'A' } }, { isError: true })]);

    expect(snapshot(fold).items).toEqual([]);
  });

  it('adds no row for a hook TaskCreate whose response holds no task id', () => {
    const fold = newFold();

    foldHookPayload(fold, hookCall('TaskCreate', 'c1', { subject: 'A' }, { task: { subject: 'A' } }));
    foldHookPayload(fold, hookCall('TaskCreate', 'c2', { subject: 'A' }, {}));

    expect(snapshot(fold).items).toEqual([]);
  });

  it('reads the id of a created task from the result text when the transcript line has no toolUseResult', () => {
    const fold = foldedFrom([assistantLine('c1', 'TaskCreate', { subject: 'A' }), resultLine('c1', undefined, { content: 'Task #7 created successfully: A' })]);

    expect(rowsOf(fold)).toEqual(['7:pending:A']);
  });

  it('changes nothing for a TaskUpdate whose result says success false or is an error', () => {
    const fold = foldedFrom(createLines('c1', '1', 'A'));

    foldHookPayload(fold, hookCall('TaskUpdate', 'u1', { taskId: '1', status: 'completed' }, { success: false, taskId: '1' }));
    foldLines(fold, [assistantLine('u2', 'TaskUpdate', { taskId: '1', status: 'completed' }), resultLine('u2', { success: true, taskId: '1' }, { isError: true })]);

    expect(rowsOf(fold)).toEqual(['1:pending:A']);
  });

  it('changes nothing for a todo call the agent made but never got a result for', () => {
    const fold = foldedFrom([assistantLine('c1', 'TaskCreate', { subject: 'A' })]);

    expect(snapshot(fold).items).toEqual([]);
  });

  it('never shows a subagent\'s todos: lines of a sidechain are skipped', () => {
    const sidechain = createLines('c1', '1', 'Subagent task').map((line) => JSON.stringify({ ...JSON.parse(line), isSidechain: true }));

    expect(snapshot(foldedFrom(sidechain)).items).toEqual([]);
  });
});

describe('the list stays bounded', () => {
  const tenThousandCreates = () => Array.from({ length: 10_000 }, (_, index) => hookCall('TaskCreate', `c${index}`, { subject: `T${index}` }, { task: { id: String(index), subject: `T${index}` } }));

  it('lists MAX_TODO_ITEMS of the MAX_TRACKED_TASKS it tracks, counts all tracked, and reports the rest as omitted', () => {
    const fold = newFold();

    tenThousandCreates().forEach((call) => foldHookPayload(fold, call));

    const result = snapshot(fold);
    expect(result.items).toHaveLength(MAX_TODO_ITEMS);
    expect(result.counts).toEqual({ total: MAX_TRACKED_TASKS, completed: 0, inProgress: 0, pending: MAX_TRACKED_TASKS });
    expect(result.omitted).toBe(10_000 - MAX_TODO_ITEMS);
  });

  it('counts the entries of a TaskList beyond the cap as omitted', () => {
    const tasks = Array.from({ length: 10_000 }, (_, index) => ({ id: String(index), subject: `T${index}`, status: 'completed' }));
    const fold = newFold();

    foldHookPayload(fold, hookCall('TaskList', 'l1', {}, { tasks }));

    expect(snapshot(fold).counts.total).toBe(MAX_TRACKED_TASKS);
    expect(snapshot(fold).omitted).toBe(10_000 - MAX_TODO_ITEMS);
  });

  it('remembers only the most recent unanswered todo calls of the transcript', () => {
    const unanswered = Array.from({ length: 10_000 }, (_, index) => assistantLine(`call-${index}`, 'TaskCreate', { subject: `T${index}` }));
    const fold = foldedFrom(unanswered);

    foldLines(fold, [resultLine('call-0', { task: { id: '1', subject: 'T0' } }), resultLine('call-9999', { task: { id: '2', subject: 'T9999' } })]);

    expect(rowsOf(fold)).toEqual(['2:pending:T9999']);
  });

  it('creates a placeholder within the cap when a full fold meets an unknown id, and counts it as omitted when there is no room', () => {
    const fold = newFold();
    tenThousandCreates().slice(0, MAX_TRACKED_TASKS).forEach((call) => foldHookPayload(fold, call));

    foldHookPayload(fold, hookCall('TaskUpdate', 'u1', { taskId: 'new', status: 'in_progress' }, { success: true, taskId: 'new' }));

    expect(snapshot(fold).counts.total).toBe(MAX_TRACKED_TASKS);
    expect(snapshot(fold).omitted).toBe(MAX_TRACKED_TASKS - MAX_TODO_ITEMS + 1);
  });

  it('counts an untracked id once however many times it is updated', () => {
    const fold = newFold();
    tenThousandCreates().slice(0, MAX_TRACKED_TASKS).forEach((call) => foldHookPayload(fold, call));

    ['u1', 'u2', 'u3', 'u4', 'u5'].forEach((id) => foldHookPayload(fold, hookCall('TaskUpdate', id, { taskId: 'new', status: 'in_progress' }, { success: true, taskId: 'new' })));
    foldHookPayload(fold, hookCall('TaskUpdate', 'u6', { taskId: 'other', status: 'completed' }, { success: true, taskId: 'other' }));

    expect(snapshot(fold).omitted).toBe(MAX_TRACKED_TASKS - MAX_TODO_ITEMS + 2);
  });

  it('counts the entries of a TodoWrite beyond the cap as omitted', () => {
    const written = Array.from({ length: MAX_TRACKED_TASKS + 100 }, (_, index) => ({ content: `T${index}`, status: 'pending' }));
    const fold = newFold();

    applyCompletedCall(fold, { toolUseId: 'w1', name: 'TodoWrite', input: { todos: written }, response: undefined });

    expect(snapshot(fold).counts.total).toBe(MAX_TRACKED_TASKS);
    expect(snapshot(fold).omitted).toBe(MAX_TRACKED_TASKS + 100 - MAX_TODO_ITEMS);
  });

  it('forgets the overflow of earlier creates when a TaskList replaces the list', () => {
    const fold = newFold();
    tenThousandCreates().slice(0, MAX_TRACKED_TASKS + 10).forEach((call) => foldHookPayload(fold, call));
    expect(snapshot(fold).omitted).toBeGreaterThan(MAX_TRACKED_TASKS - MAX_TODO_ITEMS);

    foldHookPayload(fold, hookCall('TaskList', 'l1', {}, { tasks: [{ id: '1', subject: 'A', status: 'pending' }, { id: '2', subject: 'B', status: 'pending' }, { id: '3', subject: 'C', status: 'pending' }] }));

    expect(snapshot(fold).omitted).toBe(0);
  });

  it('forgets the overflow of an earlier long TaskList when a shorter one replaces it', () => {
    const tasksOf = (count: number) => Array.from({ length: count }, (_, index) => ({ id: String(index), subject: `T${index}`, status: 'pending' }));
    const fold = newFold();
    foldHookPayload(fold, hookCall('TaskList', 'l1', {}, { tasks: tasksOf(MAX_TRACKED_TASKS + 100) }));
    expect(snapshot(fold).omitted).toBeGreaterThan(MAX_TRACKED_TASKS - MAX_TODO_ITEMS);

    foldHookPayload(fold, hookCall('TaskList', 'l2', {}, { tasks: tasksOf(3) }));

    expect(snapshot(fold).omitted).toBe(0);
  });

  it('remembers at most MAX_TRACKED_TASKS untracked ids and still counts every further one', () => {
    const fold = newFold();
    tenThousandCreates().slice(0, MAX_TRACKED_TASKS).forEach((call) => foldHookPayload(fold, call));
    const untrackedCount = MAX_TRACKED_TASKS + 100;

    Array.from({ length: untrackedCount }, (_, index) => `x${index}`).forEach((taskId) => {
      foldHookPayload(fold, hookCall('TaskUpdate', `u-${taskId}`, { taskId, status: 'pending' }, { success: true, taskId }));
    });

    expect(fold.untrackedTaskIds.size).toBe(MAX_TRACKED_TASKS);
    expect(snapshot(fold).omitted).toBe(MAX_TRACKED_TASKS - MAX_TODO_ITEMS + untrackedCount);
  });

  it('frees the count of an untracked task that is deleted', () => {
    const fold = newFold();
    tenThousandCreates().slice(0, MAX_TRACKED_TASKS).forEach((call) => foldHookPayload(fold, call));
    foldHookPayload(fold, hookCall('TaskUpdate', 'u1', { taskId: 'new', status: 'in_progress' }, { success: true, taskId: 'new' }));

    foldHookPayload(fold, hookCall('TaskUpdate', 'u2', { taskId: 'new', status: 'deleted' }, { success: true, taskId: 'new' }));

    expect(snapshot(fold).omitted).toBe(MAX_TRACKED_TASKS - MAX_TODO_ITEMS);
  });

  it('does not count a repeated id again when the set of untracked ids is full', () => {
    const fold = newFold();
    tenThousandCreates().slice(0, MAX_TRACKED_TASKS).forEach((call) => foldHookPayload(fold, call));
    const updateOf = (taskId: string, callId: string) => hookCall('TaskUpdate', callId, { taskId, status: 'pending' }, { success: true, taskId });
    Array.from({ length: MAX_TRACKED_TASKS }, (_, index) => `x${index}`).forEach((taskId) => foldHookPayload(fold, updateOf(taskId, `first-${taskId}`)));
    const omittedWhenFull = snapshot(fold).omitted;

    foldHookPayload(fold, updateOf('x0', 'again'));

    expect(snapshot(fold).omitted).toBe(omittedWhenFull);
  });

  it('counts an untracked id once when a later update gives it a row', () => {
    const fold = newFold();
    const creates = tenThousandCreates().slice(0, MAX_TRACKED_TASKS);
    creates.forEach((call) => foldHookPayload(fold, call));
    foldHookPayload(fold, hookCall('TaskUpdate', 'u1', { taskId: 'new', status: 'in_progress' }, { success: true, taskId: 'new' }));
    foldHookPayload(fold, hookCall('TaskUpdate', 'd1', { taskId: '1', status: 'deleted' }, { success: true, taskId: '1' }));

    foldHookPayload(fold, hookCall('TaskUpdate', 'u2', { taskId: 'new', subject: 'Now tracked' }, { success: true, taskId: 'new' }));

    expect(snapshot(fold).counts.total).toBe(MAX_TRACKED_TASKS);
    expect(snapshot(fold).omitted).toBe(MAX_TRACKED_TASKS - MAX_TODO_ITEMS);
  });

  it('counts an untracked id once when a TaskCreate gives it a row', () => {
    const fold = newFold();
    tenThousandCreates().slice(0, MAX_TRACKED_TASKS).forEach((call) => foldHookPayload(fold, call));
    foldHookPayload(fold, hookCall('TaskUpdate', 'u1', { taskId: 'new', status: 'in_progress' }, { success: true, taskId: 'new' }));
    foldHookPayload(fold, hookCall('TaskUpdate', 'd1', { taskId: '1', status: 'deleted' }, { success: true, taskId: '1' }));

    foldHookPayload(fold, hookCall('TaskCreate', 'create-new', { subject: 'Now tracked' }, { task: { id: 'new', subject: 'Now tracked' } }));

    expect(snapshot(fold).omitted).toBe(MAX_TRACKED_TASKS - MAX_TODO_ITEMS);
  });
});

describe('the calls waiting for their result hold masked, bounded text', () => {
  it('keeps no credential in clear while a TaskCreate waits for its result', () => {
    const fold = foldedFrom([assistantLine('c1', 'TaskCreate', { subject: 'rotate sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123', activeForm: 'rotating sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123' })]);

    expect(JSON.stringify([...fold.pendingCalls.values()])).not.toContain('AbCdEf');
  });

  it('holds about MAX_TODO_ITEMS short texts per pending TodoWrite: 100 pending writes of 500 entries of 500 characters stay within 3 MB', () => {
    const todos = Array.from({ length: 500 }, () => ({ content: 'x'.repeat(500), status: 'pending' }));
    const fold = foldedFrom(Array.from({ length: 100 }, (_, index) => assistantLine(`w${index}`, 'TodoWrite', { todos })));

    const heldCharacters = JSON.stringify([...fold.pendingCalls.values()]).length;

    expect(fold.pendingCalls.size).toBe(100);
    expect(heldCharacters).toBeLessThan(3_000_000);
  });

  it('folds a pending TodoWrite of 500 entries into MAX_TODO_ITEMS shown rows and the rest omitted', () => {
    const todos = Array.from({ length: 500 }, (_, index) => ({ content: `T${index}`, status: 'pending' }));
    const fold = foldedFrom([assistantLine('w1', 'TodoWrite', { todos }), resultLine('w1', {})]);

    expect(snapshot(fold).items).toHaveLength(MAX_TODO_ITEMS);
    expect(snapshot(fold).omitted).toBe(500 - MAX_TODO_ITEMS);
  });
});

describe('the transcript prefilter', () => {
  it('parses a tool_result line only when it names a pending tool_use_id', () => {
    const fold = foldedFrom([assistantLine('pending-1', 'TaskCreate', { subject: 'A' })]);
    const unrelatedResult = resultLine('read-1', { file: 'x' });
    const parse = vi.spyOn(JSON, 'parse');

    foldLines(fold, [unrelatedResult]);
    const parsedTheUnrelatedLine = parse.mock.calls.some(([text]) => text === unrelatedResult);
    foldLines(fold, [resultLine('pending-1', { task: { id: '1', subject: 'A' } })]);
    parse.mockRestore();

    expect(parsedTheUnrelatedLine).toBe(false);
    expect(rowsOf(fold)).toEqual(['1:pending:A']);
  });
});

describe('text normalisation', () => {
  it('caps a 10 000-character subject, marks the cut, and stays within MAX_TODO_TEXT', () => {
    const text = normalisedTodoText('x'.repeat(10_000));

    expect(text).toHaveLength(MAX_TODO_TEXT);
    expect(text.endsWith('…')).toBe(true);
  });

  it('leaves a text of exactly MAX_TODO_TEXT characters as it is', () => {
    expect(normalisedTodoText('y'.repeat(MAX_TODO_TEXT))).toBe('y'.repeat(MAX_TODO_TEXT));
  });

  it('turns control characters, bidi overrides, line separators and whitespace runs into one space', () => {
    expect(normalisedTodoText('a‮b\u0000c\u0085d e  \n\t f⁦g‏h')).toBe('a b c d e f g h');
  });

  it('normalises to NFC and keeps an emoji ZWJ sequence and a combining mark', () => {
    expect(normalisedTodoText('café')).toBe('café');
    expect(normalisedTodoText('family 👨‍👩‍👧')).toBe('family 👨‍👩‍👧');
  });

  it('replaces a lone surrogate and never cuts a surrogate pair in two', () => {
    expect(normalisedTodoText('a\uD800b')).toBe('a�b');
    const cutThroughAnEmoji = normalisedTodoText('😀'.repeat(300));
    expect(cutThroughAnEmoji).toBe(`${'😀'.repeat(99)}…`);
    expect(() => encodeURIComponent(cutThroughAnEmoji)).not.toThrow();
  });

  it('masks a provider key that straddles the 200-character cut: the mask runs before the cut', () => {
    const text = normalisedTodoText(`${'a'.repeat(176)} sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz`);

    expect(text).not.toContain('AbCdEf');
    expect(text.length).toBeLessThanOrEqual(MAX_TODO_TEXT);
  });

  it('masks a Basic credential that the head cut of a long text leaves in two, once masking has shrunk the text enough to show it', () => {
    const maskedUnit = 'ok Basic dXNlcjpwYXNzd29yZA== ';
    const text = normalisedTodoText(`${maskedUnit.repeat(12)}${'y'.repeat(20)} Basic dXNlcjpwYXNzd29yZA==`);

    expect(text).not.toContain('dXNlcj');
    expect(text.endsWith('Basic ***')).toBe(true);
  });

  it('leaves a sentence that merely ends in the word Basic alone when nothing was cut', () => {
    expect(normalisedTodoText('Use Basic authentication')).toBe('Use Basic authentication');
  });

  it('drops the row of a TaskCreate whose subject is empty after normalisation', () => {
    const fold = newFold();

    foldHookPayload(fold, hookCall('TaskCreate', 'c1', { subject: `${String.fromCodePoint(0x202e)} \n ` }, { task: { id: '1' } }));

    expect(snapshot(fold).items).toEqual([]);
  });
});

describe('secrets in a todo text reach the snapshot masked, by either source', () => {
  const secrets = [
    ['a Bearer token', 'call with Bearer abc123def456ghi789', 'abc123def456ghi789'],
    ['a Basic credential after Authorization', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpw'],
    ['URL credentials', 'clone https://user:hunter2pass@example.com/repo', 'hunter2pass'],
    ['a secret query parameter', 'open https://example.com/x?token=abc123secretvalue', 'abc123secretvalue'],
    ['a password pair', 'set password=correcthorsebattery', 'correcthorsebattery'],
    ['a hook token path', 'curl http://127.0.0.1:7777/hooks/0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef'],
    ['a bare provider key', 'use sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'AbCdEfGhIjKlMnOpQrStUvWxYz'],
  ] as const;

  it.each(secrets)('hides %s arriving by the hook', (_name, subject, secret) => {
    const fold = newFold();

    foldHookPayload(fold, hookCall('TaskCreate', 'c1', { subject }, { task: { id: '1', subject } }));

    expect(JSON.stringify(snapshot(fold))).not.toContain(secret);
    expect(snapshot(fold).items).toHaveLength(1);
  });

  it.each(secrets)('hides %s arriving by the transcript', (_name, subject, secret) => {
    const fold = foldedFrom(createLines('c1', '1', subject));

    expect(JSON.stringify(snapshot(fold))).not.toContain(secret);
    expect(snapshot(fold).items).toHaveLength(1);
  });

  it('hides a secret in the activeForm and in a TaskList subject as well', () => {
    const fold = newFold();
    foldHookPayload(fold, hookCall('TaskCreate', 'c1', { subject: 'A', activeForm: 'Bearer abc123def456ghi789' }, { task: { id: '1', subject: 'A' } }));
    foldHookPayload(fold, hookCall('TaskList', 'l1', {}, { tasks: [{ id: '2', subject: 'password=correcthorsebattery', status: 'pending' }] }));

    expect(JSON.stringify(snapshot(fold))).not.toMatch(/abc123def456ghi789|correcthorsebattery/);
  });
});

describe('the updatedAt stamp', () => {
  it('falls back to the daemon clock for a timestamp in the future', () => {
    const fold = foldedFrom([assistantLine('c1', 'TaskCreate', { subject: 'A' }, { timestamp: '2099-01-01T00:00:00.000Z' }), resultLine('c1', { task: { id: '1' } })].map((line) => JSON.stringify({ ...JSON.parse(line), timestamp: '2099-01-01T00:00:00.000Z' })));

    expect(snapshot(fold).updatedAt).toBe(NOW.toISOString());
  });

  it('falls back to the daemon clock for a timestamp before the session existed, or that is not a date', () => {
    const fold = createTodoFold({ now: () => NOW, notBefore: new Date('2026-09-30T16:00:00.000Z') });
    const stamped = (timestamp: string) => createLines('c', '1', 'A').map((line) => JSON.stringify({ ...JSON.parse(line), timestamp }));

    foldLines(fold, stamped('2001-01-01T00:00:00.000Z'));
    expect(snapshot(fold).updatedAt).toBe(NOW.toISOString());

    const other = createTodoFold({ now: () => NOW, notBefore: new Date('2026-09-30T16:00:00.000Z') });
    foldLines(other, stamped('not a date'));
    expect(snapshot(other).updatedAt).toBe(NOW.toISOString());
  });

  const stampOfCompletedCallAt = (at: string): string | null => {
    const fold = newFold();
    applyCompletedCall(fold, { toolUseId: 'c1', name: 'TaskCreate', input: { subject: 'A' }, response: { task: { id: '1' } }, at });
    return snapshot(fold).updatedAt;
  };

  it('keeps the stamp of a call completed within the clock tolerance ahead of the daemon clock', () => {
    const thirtySecondsAhead = new Date(NOW.getTime() + 30_000).toISOString();

    expect(stampOfCompletedCallAt(thirtySecondsAhead)).toBe(thirtySecondsAhead);
  });

  it('falls back to the daemon clock for a timestamp more than the tolerance ahead', () => {
    expect(stampOfCompletedCallAt(new Date(NOW.getTime() + 120_000).toISOString())).toBe(NOW.toISOString());
  });

  it('falls back to the daemon clock for a timestamp string of 10 000 characters, even one that starts as a date', () => {
    const aParseableDateWithALongComment = `Wed, 30 Sep 2026 16:30:00 GMT (${'x'.repeat(10_000)})`;
    expect(Number.isFinite(Date.parse(aParseableDateWithALongComment))).toBe(true);

    expect(stampOfCompletedCallAt(aParseableDateWithALongComment)).toBe(NOW.toISOString());
  });
});

describe('hostile input never throws and never pollutes', () => {
  it.each([
    ['a JSON array line', '[1,2,3]'],
    ['a number line', '42'],
    ['a null line', 'null'],
    ['a string line', '"TaskCreate"'],
    ['a line with a NUL byte', `{"type":"assistant","note":"TaskCreate\u0000"}`],
    ['an unterminated JSON line mentioning a todo tool', '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"TaskCreate"'],
    ['malformed JSON', '{{{ TaskCreate'],
    ['a message whose content is a string', JSON.stringify({ type: 'assistant', message: { content: 'TaskCreate' } })],
    ['a message without content', JSON.stringify({ type: 'user', message: {}, toolUseResult: 'TaskCreate' })],
    ['blocks that are not objects', JSON.stringify({ type: 'assistant', message: { content: [null, 4, 'TaskCreate', [1]] } })],
  ])('skips %s and still folds the valid lines around it', (_name, hostileLine) => {
    const fold = foldedFrom(createLines('c1', '1', 'before'), [hostileLine], createLines('c2', '2', 'after'));

    expect(rowsOf(fold)).toEqual(['1:pending:before', '2:pending:after']);
  });

  it('skips a 5 MiB single line without parsing it and still folds the next one', () => {
    const fiveMiBLine = `{"type":"assistant","padding":"TaskCreate ${'x'.repeat(5 * 1024 * 1024)}"}`;

    const fold = foldedFrom([fiveMiBLine], createLines('c1', '1', 'after'));

    expect(rowsOf(fold)).toEqual(['1:pending:after']);
  });

  it('ignores a result that arrives before its call and a result nobody called', () => {
    const fold = foldedFrom(
      [resultLine('early', { task: { id: '1', subject: 'early' } })],
      [assistantLine('early', 'TaskCreate', { subject: 'early' })],
      [resultLine('ghost', { task: { id: '2', subject: 'ghost' } })],
    );

    expect(snapshot(fold).items).toEqual([]);
  });

  it('keeps the first id when one TaskCreate result is read twice with different ids', () => {
    const fold = foldedFrom([assistantLine('c1', 'TaskCreate', { subject: 'A' }), resultLine('c1', { task: { id: '1', subject: 'A' } }), resultLine('c1', { task: { id: '2', subject: 'A' } })]);

    expect(rowsOf(fold)).toEqual(['1:pending:A']);
  });

  it.each([['__proto__'], ['constructor'], ['toString'], ['hasOwnProperty']])('treats the id %j as a plain string and pollutes nothing', (taskId) => {
    const fold = newFold();

    foldHookPayload(fold, hookCall('TaskCreate', 'c1', { subject: 'A' }, { task: { id: taskId, subject: 'A' } }));
    foldHookPayload(fold, hookCall('TaskUpdate', 'u1', { taskId, status: 'completed' }, { success: true, taskId }));

    expect(rowsOf(fold)).toEqual([`${taskId}:completed:A`]);
    expect(({} as Record<string, unknown>).status).toBeUndefined();
    expect(({} as Record<string, unknown>).content).toBeUndefined();
  });

  it('drops a task id of 10 000 characters or that is an object, and coerces a numeric one', () => {
    const fold = newFold();

    applyCompletedCall(fold, { toolUseId: 'c1', name: 'TaskCreate', input: { subject: 'long' }, response: { task: { id: 'x'.repeat(10_000) } } });
    applyCompletedCall(fold, { toolUseId: 'c2', name: 'TaskCreate', input: { subject: 'object' }, response: { task: { id: { a: 1 } as never } } });
    applyCompletedCall(fold, { toolUseId: 'c3', name: 'TaskCreate', input: { subject: 'number' }, response: { task: { id: 3 } } });

    expect(rowsOf(fold)).toEqual(['3:pending:number']);
  });

  it('survives every shape of call the reducer can be handed', () => {
    const fold = newFold();
    const garbage: unknown[] = [undefined, null, 0, 'text', [], {}, { toolUseId: 1 }, { toolUseId: 'x' }, { toolUseId: 'x', name: 'Bash' }, { toolUseId: 'y', name: 'TaskUpdate', input: null, response: null }, { toolUseId: 'z', name: 'TaskList', input: 7, response: { tasks: 'no' } }, { toolUseId: 'w', name: 'TodoWrite', input: { todos: 'no' } }, { toolUseId: 'v', name: 'TodoWrite', input: { todos: [null, 3, { content: { a: 1 } }] } }];

    expect(() => garbage.forEach((call) => applyCompletedCall(fold, call as never))).not.toThrow();
    expect(() => foldHookPayload(fold, undefined as never)).not.toThrow();
    expect(() => foldTranscriptText(fold, undefined as never)).not.toThrow();
    expect(snapshot(fold).items).toEqual([]);
  });

  it('answers a call for an unknown tool by ignoring it', () => {
    const fold = newFold();

    const applied = applyCompletedCall(fold, { toolUseId: 'x', name: 'TaskGet' as TodoToolName, input: {}, response: { task: { id: '1', subject: 'A' } } });

    expect(applied).toBe(false);
    expect(snapshot(fold).source).toBeNull();
  });

  it('folds a forged hook body (50-deep payload, huge subject, 100 000 list entries) into a bounded list', () => {
    const tasks = Array.from({ length: 100_000 }, (_, index) => ({ id: String(index), subject: 'x'.repeat(500), status: 'pending' }));
    const fold = newFold();

    foldHookPayload(fold, hookCall('TaskList', 'l1', {}, { tasks }));

    expect(snapshot(fold).items).toHaveLength(MAX_TODO_ITEMS);
    expect(snapshot(fold).items.every((item) => item.content.length <= MAX_TODO_TEXT)).toBe(true);
  });
});

describe('after a resume the CLI restarts its task ids at #1 while the fold still holds the old rows', () => {
  const foldOldRowsFromHistory = () => {
    const fold = newFold();
    foldLines(fold, [...createLines('toolu_old1', '1', 'Old one'), ...updateLines('toolu_old1u', '1', 'completed'), ...createLines('toolu_old2', '2', 'Old two')]);
    markRowsUnverified(fold);
    return fold;
  };

  it('replaces the row entirely when a create reuses its id, so the new task is pending with the new subject and activeForm', () => {
    const fold = foldOldRowsFromHistory();

    foldHookPayload(fold, hookCall('TaskCreate', 'toolu_new1', { subject: 'New one', activeForm: 'Doing new one' }, { task: { id: '1', subject: 'New one' } }));

    expect(snapshot(fold).items).toEqual([
      { id: '1', content: 'New one', status: 'pending', activeForm: 'Doing new one' },
      { id: '2', content: 'Old two', status: 'pending', unverified: true },
    ]);
  });

  it('drops the old activeForm when the replacing create carries none', () => {
    const fold = newFold();
    foldHookPayload(fold, hookCall('TaskCreate', 'toolu_a', { subject: 'A', activeForm: 'Doing A' }, { task: { id: '1' } }));

    foldHookPayload(fold, hookCall('TaskCreate', 'toolu_b', { subject: 'B' }, { task: { id: '1' } }));

    expect(snapshot(fold).items).toEqual([{ id: '1', content: 'B', status: 'pending' }]);
  });

  it('marks every row rebuilt from history as unverified', () => {
    expect(snapshot(foldOldRowsFromHistory()).items.every((item) => item.unverified === true)).toBe(true);
  });

  it('clears the marker of one row when a live update names its id, and keeps the others', () => {
    const fold = foldOldRowsFromHistory();

    foldHookPayload(fold, hookCall('TaskUpdate', 'toolu_live', { taskId: '2', status: 'in_progress' }, { success: true, taskId: '2', statusChange: { from: 'pending', to: 'in_progress' } }));

    expect(snapshot(fold).items.map((item) => `${item.id}:${item.unverified ?? false}`)).toEqual(['1:true', '2:false']);
  });

  it('replaces the list, with no marker left, when a TaskList answers', () => {
    const fold = foldOldRowsFromHistory();

    foldHookPayload(fold, hookCall('TaskList', 'toolu_list', {}, { tasks: [{ id: '2', subject: 'Old two', status: 'pending' }] }));

    expect(snapshot(fold).items).toEqual([{ id: '2', content: 'Old two', status: 'pending' }]);
  });

  it('removes an unverified ghost row, without a warning, when the CLI answers success:false for its id', () => {
    const fold = foldOldRowsFromHistory();

    const isApplied = foldHookPayload(fold, hookCall('TaskUpdate', 'toolu_ghost', { taskId: '1', status: 'completed' }, { success: false, taskId: '1', error: 'Task not found' }));

    expect(isApplied).toBe(true);
    expect(rowsOf(fold)).toEqual(['2:pending:Old two']);
  });

  it('keeps a verified row when a failed update names its id', () => {
    const fold = newFold();
    foldHookPayload(fold, hookCall('TaskCreate', 'toolu_a', { subject: 'A' }, { task: { id: '1' } }));

    foldHookPayload(fold, hookCall('TaskUpdate', 'toolu_f', { taskId: '1', status: 'completed' }, { success: false, taskId: '1' }));

    expect(rowsOf(fold)).toEqual(['1:pending:A']);
  });
});
