import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { inspect } from 'node:util';
import { join } from 'node:path';
import type { ServerEvent, SessionTodos } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { recentLogLines } from '../logger.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { TodoTracker, type Schedule } from '../todos/todoTracker.js';
import { startServer } from './server.js';

const fixtureLines = (name: string) => readFileSync(new URL(`../todos/__fixtures__/${name}`, import.meta.url), 'utf8').split('\n').filter(Boolean);
const interactive = fixtureLines('interactive-1.jsonl');
const realHookBodies = fixtureLines('hook-post-tool-use-1.jsonl').map((line) => JSON.parse(line) as Record<string, unknown>);

// Interactive sample, by 0-based record: 0–9 run A, 10–29 run B, 30–49 run B after /clear (another transcript file, same daemon session).
const linesOf = (first: number, last: number) => interactive.slice(first, last + 1);
const cliIdOfRecord = (record: number): string => JSON.parse(interactive[record]!).sessionId;
const RUN_B_CLI_ID = cliIdOfRecord(10);
const AFTER_CLEAR_CLI_ID = cliIdOfRecord(30);

const EMIT_SETTLE_MS = 150;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let server: Awaited<ReturnType<typeof startServer>>;
let db: ReturnType<typeof openDatabase>;
let sessions: SessionService;
let tracker: TodoTracker;
let updates: SessionTodos[];
let projectsDirectory: string;
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

/** A scheduler that holds every timer until the test closes the window: what the clients are told is then independent of how fast the machine is. */
const manualSchedule = () => {
  let held: (() => void)[] = [];
  const schedule: Schedule = (run) => {
    held.push(run);
    return () => { held = held.filter((pending) => pending !== run); };
  };
  const closeTheWindow = () => held.splice(0).forEach((run) => run());
  return { schedule, closeTheWindow };
};

const restartWithManualEmitWindow = async () => {
  tracker.stop();
  await server.close();
  const emitWindow = manualSchedule();
  await boot({ schedule: emitWindow.schedule });
  return emitWindow;
};

const boot = async (options: { schedule?: Schedule } = {}) => {
  const bus = new EventBus();
  sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  tracker = new TodoTracker({ sessions, bus, schedule: options.schedule });
  updates = [];
  tracker.onUpdate((todos) => updates.push(todos));
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', todos: tracker });
};

beforeEach(async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'of-todos-claude-config-'));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  projectsDirectory = join(configDir, 'projects', 'proj');
  mkdirSync(projectsDirectory, { recursive: true });
  db = openDatabase(':memory:');
  await boot();
});

afterEach(async () => {
  vi.restoreAllMocks();
  tracker.stop();
  await server.close();
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
});

const api = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer admin', ...(init.headers ?? {}) } });
const createSession = async (name = 'Dev') => (await sessions.create({ directory: '/tmp', name, harness: 'fake', emoji: '🤖' })).id;

const transcriptOf = (cliId: string) => join(projectsDirectory, `${cliId}.jsonl`);
const writeTranscript = (cliId: string, lines: string[]) => writeFileSync(transcriptOf(cliId), `${lines.join('\n')}\n`);
const appendToTranscript = (cliId: string, lines: string[]) => appendFileSync(transcriptOf(cliId), `${lines.join('\n')}\n`);

const hookTokenOf = (id: string) => (db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(id) as { hook_token: string }).hook_token;
const rawHook = (token: string, body: unknown) => fetch(`${server.url}/hooks/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
/** Posts a hook as the CLI does: the session id and the transcript path of the conversation the hook belongs to (the session's own first conversation by default). */
const postHook = async (id: string, body: Record<string, unknown>, conversation: { cliId?: string } = {}) => {
  const cliId = conversation.cliId ?? id;
  const response = await rawHook(hookTokenOf(id), { session_id: cliId, transcript_path: transcriptOf(cliId), ...body });
  return { status: response.status, body: (await response.json()) as unknown };
};
const postTodoHook = (id: string, body: Record<string, unknown>, conversation: { cliId?: string } = {}) => postHook(id, { hook_event_name: 'PostToolUse', ...body }, conversation);
const resume = (id: string, cliId: string) => postHook(id, { hook_event_name: 'SessionStart', source: 'resume' }, { cliId });
const stop = (id: string, cliId?: string) => postHook(id, { hook_event_name: 'Stop' }, { cliId });

const todoHookOf = (body: Record<string, unknown>) => ({ tool_name: body.tool_name, tool_input: body.tool_input, tool_response: body.tool_response, tool_use_id: body.tool_use_id });
const createHook = (toolUseId: string, taskId: string, subject: string) => ({ tool_name: 'TaskCreate', tool_use_id: toolUseId, tool_input: { subject }, tool_response: { task: { id: taskId, subject } } });
const updateHook = (toolUseId: string, taskId: string, status: string) => ({ tool_name: 'TaskUpdate', tool_use_id: toolUseId, tool_input: { taskId, status }, tool_response: { success: true, taskId, statusChange: { to: status } } });
const listHook = (toolUseId: string, tasks: { id: string; subject: string; status: string }[]) => ({ tool_name: 'TaskList', tool_use_id: toolUseId, tool_input: {}, tool_response: { tasks } });

const assistantLine = (toolUseId: string, name: string, input: unknown) => JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: '2026-09-30T16:30:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name, input }] } });
const resultLine = (toolUseId: string, toolUseResult: unknown) => JSON.stringify({ type: 'user', isSidechain: false, timestamp: '2026-09-30T16:30:01.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] }, toolUseResult });
const transcriptCreate = (toolUseId: string, taskId: string, subject: string) => [assistantLine(toolUseId, 'TaskCreate', { subject }), resultLine(toolUseId, { task: { id: taskId, subject } })];
const transcriptUpdate = (toolUseId: string, taskId: string, status: string) => [assistantLine(toolUseId, 'TaskUpdate', { taskId, status }), resultLine(toolUseId, { success: true, taskId, statusChange: { to: status } })];

const getTodos = async (id: string) => (await (await api(`/api/sessions/${id}/todos`)).json()) as SessionTodos;
const rowsOf = (todos: SessionTodos) => todos.items.map((item) => `${item.id}:${item.status}:${item.content}`);
const untilQuiet = () => sleep(EMIT_SETTLE_MS);

describe('GET /api/sessions/:id/todos', () => {
  it('shows the three todos a session created with the status the agent left them in, from the hooks alone', async () => {
    const id = await createSession();

    for (const body of realHookBodies) await postTodoHook(id, todoHookOf(body));
    const todos = await getTodos(id);

    expect(rowsOf(todos)).toEqual(['1:completed:Review user feedback', '2:pending:Update documentation', '3:pending:Run performance tests']);
    expect(todos).toMatchObject({ sessionId: id, source: 'task_tools', counts: { total: 3, completed: 1, inProgress: 0, pending: 2 }, omitted: 0 });
  });

  it('answers 200 with nothing recorded for a session that never made a todo call', async () => {
    const id = await createSession();

    const response = await api(`/api/sessions/${id}/todos`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessionId: id, items: [], counts: { total: 0, completed: 0, inProgress: 0, pending: 0 }, omitted: 0, source: null, updatedAt: null });
  });

  it('answers 404 not_found with the error envelope for a session that does not exist', async () => {
    const response = await api('/api/sessions/nope/todos');

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'not_found', kind: 'not_found', retry: 'never' });
  });

  it('answers 401 without the admin token', async () => {
    const id = await createSession();

    const response = await fetch(`${server.url}/api/sessions/${id}/todos`);

    expect(response.status).toBe(401);
  });

  it('keeps the list of each session apart from the tasks of another session', async () => {
    const first = await createSession('First');
    const second = await createSession('Second');

    await postTodoHook(first, createHook('toolu_a', '1', 'Only in the first'));
    await postTodoHook(second, createHook('toolu_b', '1', 'Only in the second'));

    expect(rowsOf(await getTodos(first))).toEqual(['1:pending:Only in the first']);
    expect(rowsOf(await getTodos(second))).toEqual(['1:pending:Only in the second']);
  });

  it('is absent from a daemon built without the tracker, like any unknown route', async () => {
    await server.close();
    const bus = new EventBus();
    const bareSessions = new SessionService({ db: openDatabase(':memory:'), bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
    const managerRepo = new ManagerRepository(openDatabase(':memory:'));
    const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions: bareSessions, bus });
    server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions: bareSessions, approvals: new ApprovalService({ db: openDatabase(':memory:'), bus }), managers: new ManagerService({ managers: managerRepo, sessions: bareSessions, bus, scheduler: pulseScheduler }), pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json' });

    const response = await api('/api/sessions/anything/todos');

    expect(response.status).toBe(404);
  });
});

describe('the list follows the hooks, with no transcript line written yet', () => {
  it('tells the clients of each change once, and of nothing when a TaskList repeats what they already know', async () => {
    const emitWindow = await restartWithManualEmitWindow();
    const id = await createSession();

    await postTodoHook(id, todoHookOf(realHookBodies[0]!));
    await postTodoHook(id, todoHookOf(realHookBodies[1]!));
    await postTodoHook(id, todoHookOf(realHookBodies[2]!));
    await getTodos(id);
    emitWindow.closeTheWindow();
    const afterTheBurst = updates.length;
    await postTodoHook(id, listHook('toolu_list_1', [{ id: '1', subject: 'Review user feedback', status: 'pending' }, { id: '2', subject: 'Update documentation', status: 'pending' }, { id: '3', subject: 'Run performance tests', status: 'pending' }]));
    await getTodos(id);
    emitWindow.closeTheWindow();

    expect(afterTheBurst).toBe(1);
    expect(rowsOf(updates[0]!)).toEqual(['1:pending:Review user feedback', '2:pending:Update documentation', '3:pending:Run performance tests']);
    expect(updates).toHaveLength(afterTheBurst);
  });

  it('shows a task deleted and an in_progress status, and leaves the row alone for a status it does not know', async () => {
    const id = await createSession();
    await postTodoHook(id, createHook('toolu_1', '1', 'Keep'));
    await postTodoHook(id, createHook('toolu_2', '2', 'Drop'));

    await postTodoHook(id, updateHook('toolu_3', '1', 'in_progress'));
    await postTodoHook(id, updateHook('toolu_4', '2', 'deleted'));
    await postTodoHook(id, updateHook('toolu_5', '1', 'sparkling'));
    const todos = await getTodos(id);

    expect(rowsOf(todos)).toEqual(['1:in_progress:Keep']);
  });

  it('reconciles the list with a TaskList snapshot: a missing row disappears, a wrong status is corrected, an empty list empties it', async () => {
    const id = await createSession();
    await postTodoHook(id, createHook('toolu_1', '1', 'One'));
    await postTodoHook(id, createHook('toolu_2', '2', 'Two'));

    await postTodoHook(id, listHook('toolu_3', [{ id: '1', subject: 'One', status: 'completed' }]));
    const reconciled = rowsOf(await getTodos(id));
    await postTodoHook(id, listHook('toolu_4', []));

    expect(reconciled).toEqual(['1:completed:One']);
    expect((await getTodos(id)).counts.total).toBe(0);
  });

  it('caps a list of 120 tasks at 100 items, reports 20 omitted and counts all 120', async () => {
    const id = await createSession();
    const tasks = Array.from({ length: 120 }, (_, index) => ({ id: String(index + 1), subject: `Task ${index + 1}`, status: 'pending' }));

    await postTodoHook(id, listHook('toolu_big', tasks));
    const todos = await getTodos(id);

    expect(todos.items).toHaveLength(100);
    expect(todos).toMatchObject({ omitted: 20, counts: { total: 120 } });
  });

  it('keeps a fold made of hooks for a session whose transcript path is untrusted, and still answers 200', async () => {
    const id = await createSession();
    const outside = join(mkdtempSync(join(tmpdir(), 'of-todos-outside-')), `${id}.jsonl`);
    writeFileSync(outside, `${transcriptCreate('toolu_file', '9', 'From a file nobody trusts').join('\n')}\n`);

    const answer = await postHook(id, { hook_event_name: 'PostToolUse', ...createHook('toolu_a', '1', 'From the hook') }, { cliId: id });
    await rawHook(hookTokenOf(id), { hook_event_name: 'Stop', session_id: id, transcript_path: outside });
    const todos = await getTodos(id);

    expect(answer.status).toBe(200);
    expect(rowsOf(todos)).toEqual(['1:pending:From the hook']);
  });
});

describe('the transcript catches up what the hooks missed, and never folds a call twice', () => {
  it('shows each call once when its transcript line lands after its hook (real hook and transcript samples)', async () => {
    const emitWindow = await restartWithManualEmitWindow();
    const id = await createSession();
    for (const body of realHookBodies) await postTodoHook(id, todoHookOf(body), { cliId: id });
    await getTodos(id);
    emitWindow.closeTheWindow();
    const eventsAfterTheHooks = updates.length;

    writeTranscript(id, linesOf(0, 9));
    await stop(id);
    const todos = await getTodos(id);
    emitWindow.closeTheWindow();

    expect(rowsOf(todos)).toEqual(['1:completed:Review user feedback', '2:pending:Update documentation', '3:pending:Run performance tests']);
    expect(updates).toHaveLength(eventsAfterTheHooks);
  });

  it('tells the clients the list of a session the daemon just restarted on, rebuilt from its transcript at SessionStart(resume), before anyone asks', async () => {
    const id = await createSession();
    writeTranscript(RUN_B_CLI_ID, linesOf(10, 29));

    await resume(id, RUN_B_CLI_ID);
    await expect.poll(() => updates.at(-1)).toMatchObject({ counts: { total: 2, completed: 1 } });
    const todos = await getTodos(id);

    expect(rowsOf(todos)).toEqual(['1:completed:Review pull request', '2:pending:Update documentation']);
  });

  it('folds once a call whose hook arrives after the repair already read it, and sends the one event that confirms its row', async () => {
    const emitWindow = await restartWithManualEmitWindow();
    const id = await createSession();
    writeTranscript(RUN_B_CLI_ID, linesOf(10, 29));
    await resume(id, RUN_B_CLI_ID);
    await getTodos(id);
    emitWindow.closeTheWindow();
    const eventsAfterTheRepair = updates.length;

    const lateHook = JSON.parse(linesOf(18, 19)[0]!).message.content[0] as { id: string; input: Record<string, unknown> };
    await postTodoHook(id, { tool_name: 'TaskUpdate', tool_use_id: lateHook.id, tool_input: lateHook.input, tool_response: { success: true, taskId: lateHook.input.taskId, statusChange: { to: 'in_progress' } } }, { cliId: RUN_B_CLI_ID });
    await getTodos(id);
    emitWindow.closeTheWindow();

    expect(rowsOf(await getTodos(id))).toEqual(['1:completed:Review pull request', '2:pending:Update documentation']);
    expect(updates).toHaveLength(eventsAfterTheRepair + 1);
    expect(updates.at(-1)!.items.find((item) => item.id === lateHook.input.taskId)?.unverified).toBeUndefined();
  });

  it('keeps the same list after /clear: the new transcript file has no TaskCreate of the earlier tasks, and the list is never shown empty', async () => {
    const id = await createSession();
    writeTranscript(RUN_B_CLI_ID, linesOf(10, 29));
    await resume(id, RUN_B_CLI_ID);
    await getTodos(id);

    writeTranscript(AFTER_CLEAR_CLI_ID, linesOf(30, 49));
    await postHook(id, { hook_event_name: 'SessionStart', source: 'clear' }, { cliId: AFTER_CLEAR_CLI_ID });
    await stop(id, AFTER_CLEAR_CLI_ID);
    const todos = await getTodos(id);

    expect(rowsOf(todos)).toEqual(['1:completed:Review pull request', '2:in_progress:Update documentation', '4:completed:Check ids after clear', '5:pending:Timing A', '6:pending:Timing B']);
    expect(updates.every((update) => update.counts.total > 0)).toBe(true);
  });

  it('keeps the rows created before /clear when the new file holds only later calls and no TaskList to rebuild from', async () => {
    const id = await createSession();
    writeTranscript(RUN_B_CLI_ID, linesOf(10, 29));
    await resume(id, RUN_B_CLI_ID);
    await getTodos(id);

    writeTranscript(AFTER_CLEAR_CLI_ID, [interactive[37]!, interactive[38]!, interactive[39]!, interactive[41]!]);
    await postHook(id, { hook_event_name: 'SessionStart', source: 'clear' }, { cliId: AFTER_CLEAR_CLI_ID });
    await stop(id, AFTER_CLEAR_CLI_ID);
    const todos = await getTodos(id);

    expect(rowsOf(todos)).toEqual(['1:completed:Review pull request', '2:in_progress:Update documentation', '4:pending:Check ids after clear']);
    expect(todos.incomplete).toBeUndefined();
  });

  it('updates a row created before /clear when the update arrives by the hook of the new conversation', async () => {
    const id = await createSession();
    writeTranscript(RUN_B_CLI_ID, linesOf(10, 29));
    await resume(id, RUN_B_CLI_ID);
    await getTodos(id);
    writeTranscript(AFTER_CLEAR_CLI_ID, []);
    await postHook(id, { hook_event_name: 'SessionStart', source: 'clear' }, { cliId: AFTER_CLEAR_CLI_ID });

    await postTodoHook(id, updateHook('toolu_after_clear', '2', 'completed'), { cliId: AFTER_CLEAR_CLI_ID });

    expect(rowsOf(await getTodos(id))).toEqual(['1:completed:Review pull request', '2:completed:Update documentation']);
  });

  it('still shows the list after a compaction marker in the file', async () => {
    const id = await createSession();
    writeTranscript(RUN_B_CLI_ID, [...linesOf(10, 17), JSON.stringify({ type: 'system', subtype: 'compact_boundary', isSidechain: false }), ...linesOf(18, 29)]);

    await resume(id, RUN_B_CLI_ID);

    expect(rowsOf(await getTodos(id))).toEqual(['1:completed:Review pull request', '2:pending:Update documentation']);
  });

  it('shows the right list for a transcript larger than the tail window: a TaskCreate 300 KiB before the end', async () => {
    const id = await createSession();
    const filler = JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1000) }] } });
    const threeHundredKiB = Array.from({ length: 300 }, () => filler);
    writeTranscript(id, [...transcriptCreate('toolu_old', '1', 'Created long ago'), ...threeHundredKiB, ...transcriptUpdate('toolu_new', '1', 'completed')]);

    await resume(id, id);

    expect(rowsOf(await getTodos(id))).toEqual(['1:completed:Created long ago']);
  });

  it('reads only what was appended at Stop, not the whole file again', async () => {
    const id = await createSession();
    writeTranscript(id, transcriptCreate('toolu_1', '1', 'First'));
    await resume(id, id);
    await getTodos(id);

    appendToTranscript(id, transcriptCreate('toolu_2', '2', 'Second'));
    await stop(id);

    expect(rowsOf(await getTodos(id))).toEqual(['1:pending:First', '2:pending:Second']);
  });

  it('never shows the todos of a subagent (sidechain lines)', async () => {
    const id = await createSession();
    const sidechain = transcriptCreate('toolu_side', '7', 'Subagent task').map((line) => JSON.stringify({ ...JSON.parse(line), isSidechain: true }));
    writeTranscript(id, [...transcriptCreate('toolu_main', '1', 'Main task'), ...sidechain]);

    await resume(id, id);

    expect(rowsOf(await getTodos(id))).toEqual(['1:pending:Main task']);
  });

  it('rebuilds from a fresh fold when the transcript is replaced by a shorter file, even after more than 2000 todo calls', async () => {
    const id = await createSession();
    const manyCalls = Array.from({ length: 2100 }, (_, index) => transcriptCreate(`toolu_many_${index}`, String(index + 1), `Old task ${index + 1}`)).flat();
    writeTranscript(id, manyCalls);
    await resume(id, id);
    await getTodos(id);

    writeFileSync(`${transcriptOf(id)}.next`, `${transcriptCreate('toolu_new_1', '1', 'Replacement')[0]!}\n${transcriptCreate('toolu_new_1', '1', 'Replacement')[1]!}\n`);
    execFileSync('mv', [`${transcriptOf(id)}.next`, transcriptOf(id)]);
    await stop(id);
    const todos = await getTodos(id);

    expect(rowsOf(todos)).toEqual(['1:pending:Replacement']);
  });

  it('does not read a transcript that is a symbolic link out of the projects directory', async () => {
    const id = await createSession();
    const outside = join(mkdtempSync(join(tmpdir(), 'of-todos-outside-')), 'elsewhere.jsonl');
    writeFileSync(outside, `${transcriptCreate('toolu_out', '1', 'Planted').join('\n')}\n`);
    symlinkSync(outside, transcriptOf(id));

    await resume(id, id);

    expect((await getTodos(id)).source).toBeNull();
  });

  it('refuses a transcript named after the session that is a symbolic link to another conversation inside the projects directory', async () => {
    const id = await createSession();
    const anotherConversation = join(projectsDirectory, 'another-sessions-conversation.jsonl');
    writeFileSync(anotherConversation, `${transcriptCreate('toolu_other', '1', 'Another session task').join('\n')}\n`);
    symlinkSync(anotherConversation, transcriptOf(id));

    await resume(id, id);
    await stop(id);

    expect((await getTodos(id)).source).toBeNull();
  });

  it('keeps a status the hook folded when the first catch-up reads a file that holds older history (no repair ran before)', async () => {
    const id = await createSession();
    writeTranscript(id, [
      ...transcriptCreate('toolu_c', '1', 'Ship'),
      assistantLine('toolu_l', 'TaskList', {}),
      resultLine('toolu_l', { tasks: [{ id: '1', subject: 'Ship', status: 'pending', blockedBy: [] }] }),
      ...transcriptUpdate('toolu_n', '1', 'completed'),
    ]);

    await postTodoHook(id, updateHook('toolu_n', '1', 'completed'), { cliId: id });
    await stop(id);
    const todos = await getTodos(id);

    expect(rowsOf(todos)).toEqual(['1:completed:Ship']);
  });

  it('answers a GET for a closed session the tracker does not hold with an empty list, and holds no state for it', async () => {
    const id = await createSession();
    await sessions.close(id);
    tracker.stop();
    await server.close();
    await boot();

    for (let attempt = 0; attempt < 20; attempt += 1) expect((await getTodos(id)).source).toBeNull();

    expect((tracker as unknown as { states: Map<string, unknown> }).states.size).toBe(0);
  });

  it('reads the resolved file, not the reported path, when the transcript is a symbolic link to a file of the same name inside the projects directory', async () => {
    const id = await createSession();
    mkdirSync(join(projectsDirectory, 'nested'));
    writeFileSync(join(projectsDirectory, 'nested', `${id}.jsonl`), `${transcriptCreate('toolu_1', '1', 'Behind a link').join('\n')}\n`);
    symlinkSync(join(projectsDirectory, 'nested', `${id}.jsonl`), transcriptOf(id));

    await resume(id, id);

    expect(rowsOf(await getTodos(id))).toEqual(['1:pending:Behind a link']);
  });

  it('finds a call in the transcript when its hook came with no tool_use_id and its line was written after the hook', async () => {
    const id = await createSession();
    await postTodoHook(id, createHook('toolu_first', '1', 'Already known'));
    await getTodos(id);
    await postTodoHook(id, { tool_name: 'TaskCreate', tool_input: { subject: 'Late line' }, tool_response: { task: { id: '2', subject: 'Late line' } } });

    writeTranscript(id, [...transcriptCreate('toolu_first', '1', 'Already known'), ...transcriptCreate('toolu_late', '2', 'Late line')]);

    await expect.poll(async () => rowsOf(await getTodos(id)), { timeout: 3000, interval: 100 }).toEqual(['1:pending:Already known', '2:pending:Late line']);
  });

  it('repairs a hook that never arrived at the SessionEnd of the session', async () => {
    const id = await createSession();
    await postTodoHook(id, createHook('toolu_1', '1', 'Delivered'));
    await getTodos(id);
    writeTranscript(id, [...transcriptCreate('toolu_1', '1', 'Delivered'), ...transcriptCreate('toolu_2', '2', 'Dropped hook')]);

    await postHook(id, { hook_event_name: 'SessionEnd' });

    expect(rowsOf(await getTodos(id))).toEqual(['1:pending:Delivered', '2:pending:Dropped hook']);
  });

  it('answers without hanging when the transcript is a named pipe', async () => {
    const id = await createSession();
    execFileSync('mkfifo', [transcriptOf(id)]);

    await resume(id, id);
    const todos = await getTodos(id);

    expect(todos.source).toBeNull();
  });

  it('refuses to read a transcript whose name is not the session conversation', async () => {
    const id = await createSession();
    const foreign = join(projectsDirectory, 'someone-elses-conversation.jsonl');
    writeFileSync(foreign, `${transcriptCreate('toolu_foreign', '1', 'Foreign task').join('\n')}\n`);

    await rawHook(hookTokenOf(id), { hook_event_name: 'SessionStart', source: 'resume', session_id: id, transcript_path: foreign });

    expect((await getTodos(id)).source).toBeNull();
  });
});

describe('closed sessions', () => {
  it('keeps the last list of a closed session readable', async () => {
    const id = await createSession();
    await postTodoHook(id, createHook('toolu_1', '1', 'Finish me'));
    await getTodos(id);

    await sessions.close(id);

    expect(rowsOf(await getTodos(id))).toEqual(['1:pending:Finish me']);
  });

  it('keeps a closed session out of the fold map: a hook for it is ignored', async () => {
    const id = await createSession();
    const token = hookTokenOf(id);
    await sessions.close(id);

    const response = await rawHook(token, { hook_event_name: 'PostToolUse', session_id: id, ...createHook('toolu_late', '1', 'Too late') });

    expect(response.status).toBe(200);
    expect((await getTodos(id)).source).toBeNull();
  });
});

describe('a wrong hook token never reaches the fold', () => {
  it('answers 200 and changes nothing', async () => {
    const id = await createSession();

    const response = await rawHook('not-a-token', { hook_event_name: 'PostToolUse', session_id: id, ...createHook('toolu_a', '1', 'Forged') });

    expect(response.status).toBe(200);
    expect((await getTodos(id)).source).toBeNull();
  });
});

describe('WebSocket', () => {
  const connect = async () => {
    const { ticket } = (await (await api('/api/ws-ticket', { method: 'POST' })).json()) as { ticket: string };
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
    const received: ServerEvent[] = [];
    const firstFrame = new Promise<void>((resolve) => ws.addEventListener('message', () => resolve(), { once: true }));
    ws.addEventListener('message', (message) => received.push(JSON.parse(String(message.data))));
    await firstFrame;
    const snapshot = received.shift() as Extract<ServerEvent, { type: 'snapshot' }>;
    return { ws, received, snapshot };
  };

  it('sends session.todos after a TaskCreate hook, with no transcript line written', async () => {
    const id = await createSession();
    const connection = await connect();

    await postTodoHook(id, todoHookOf(realHookBodies[0]!));
    await expect.poll(() => connection.received.filter((event) => event.type === 'session.todos')).toHaveLength(1);
    connection.ws.close();

    expect(connection.received.find((event) => event.type === 'session.todos')).toMatchObject({ type: 'session.todos', todos: { sessionId: id, items: [{ id: '1', status: 'pending', content: 'Review user feedback' }] } });
  });

  it('carries todoSummaries in the snapshot for sessions with a list, including a closed one, and none for a session without', async () => {
    const withList = await createSession('With');
    const closed = await createSession('Closed');
    await createSession('Without');
    await postTodoHook(withList, createHook('toolu_a', '1', 'One'));
    await postTodoHook(closed, updateHook('toolu_b', '1', 'completed'));
    await getTodos(withList);
    await getTodos(closed);
    await sessions.close(closed);

    const connection = await connect();
    connection.ws.close();

    expect(connection.snapshot.todoSummaries?.map((summary) => summary.sessionId).sort()).toEqual([withList, closed].sort());
    expect(connection.snapshot.todoSummaries?.find((summary) => summary.sessionId === closed)).toMatchObject({ counts: { total: 1, completed: 1 } });
  });

  it('has no todoSummaries in the snapshot of a daemon without the tracker', async () => {
    await server.close();
    const bus = new EventBus();
    const bareDb = openDatabase(':memory:');
    const bareSessions = new SessionService({ db: bareDb, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
    const managerRepo = new ManagerRepository(bareDb);
    const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions: bareSessions, bus });
    server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions: bareSessions, approvals: new ApprovalService({ db: bareDb, bus }), managers: new ManagerService({ managers: managerRepo, sessions: bareSessions, bus, scheduler: pulseScheduler }), pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json' });

    const connection = await connect();
    connection.ws.close();

    expect(connection.snapshot).not.toHaveProperty('todoSummaries');
  });
});

describe('what a todo may hold never leaves the daemon', () => {
  const SECRET = 'abc123def456ghi789';
  const hostileSubject = `Call the API with Bearer ${SECRET} then open https://example.test/cb?token=${SECRET}`;

  beforeEach(() => { vi.stubEnv('OPENFLEET_LOG_LEVEL', 'debug'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  const everythingTheDaemonSaid = async (id: string, extra: () => string[]) => {
    const rest = JSON.stringify(await getTodos(id));
    return [rest, JSON.stringify(updates), recentLogLines().join('\n'), ...extra()].join('\n');
  };

  it('masks a credential in a subject that arrived by the hook, in REST, in events and in every log line', async () => {
    const id = await createSession();
    const logged: string[] = [];
    for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));

    await postTodoHook(id, createHook('toolu_secret', '1', hostileSubject));
    const said = await everythingTheDaemonSaid(id, () => logged);

    expect(said).not.toContain(SECRET);
    expect((await getTodos(id)).items[0]!.content).toContain('Bearer');
  });

  it('masks a credential in a subject that arrived by the transcript', async () => {
    const id = await createSession();
    writeTranscript(id, transcriptCreate('toolu_secret', '1', hostileSubject));

    await resume(id, id);
    const said = await everythingTheDaemonSaid(id, () => []);

    expect(said).not.toContain(SECRET);
    expect((await getTodos(id)).counts.total).toBe(1);
  });

  it('caps a 10 000 character subject at 200 characters ending in an ellipsis', async () => {
    const id = await createSession();

    await postTodoHook(id, createHook('toolu_long', '1', 'y'.repeat(10_000)));
    const [item] = (await getTodos(id)).items;

    expect(item!.content).toHaveLength(200);
    expect(item!.content.endsWith('…')).toBe(true);
  });

  it('logs no hook body and no todo text when the hook body is malformed or hostile', async () => {
    const id = await createSession();

    await postTodoHook(id, { tool_name: 'TaskCreate', tool_use_id: 'toolu_bad', tool_input: { subject: { SECRET } }, tool_response: { task: { id: { SECRET } } } });
    await postTodoHook(id, { tool_name: 'TaskList', tool_use_id: 'toolu_bad_2', tool_input: {}, tool_response: { tasks: 'not an array' } });
    await untilQuiet();

    expect(recentLogLines().join('\n')).not.toContain(SECRET);
  });
});

describe('the event forwarded to the state machine never carries a tool payload', () => {
  it('strips tool_input and tool_response from a PostToolUse before applyInput sees them', async () => {
    const id = await createSession();
    const applyInput = vi.spyOn(sessions, 'applyInput');
    const bashOutput = 'z'.repeat(900 * 1024);

    await postTodoHook(id, { tool_name: 'Bash', tool_use_id: 'toolu_bash', tool_input: { command: 'cat big' }, tool_response: { stdout: bashOutput } });
    await postTodoHook(id, createHook('toolu_todo', '1', 'A todo'));

    const forwarded = applyInput.mock.calls.map(([, input]) => input).filter((input) => input.kind === 'hook').map((input) => input.kind === 'hook' ? input.event : undefined);
    expect(forwarded).toHaveLength(2);
    for (const event of forwarded) {
      expect(event).not.toHaveProperty('tool_input');
      expect(event).not.toHaveProperty('tool_response');
    }
    expect(JSON.stringify(forwarded)).not.toContain('zzzzzzzz');
  });

  it('retains nothing of a 5 MiB Bash tool_response and answers the next todo hook as fast as before it', async () => {
    const id = await createSession();
    const hookLatencyMs = async (toolUseId: string) => {
      const start = performance.now();
      await postTodoHook(id, createHook(toolUseId, toolUseId, 'A todo'));
      return performance.now() - start;
    };
    await hookLatencyMs('1');
    const before = Math.min(await hookLatencyMs('2'), await hookLatencyMs('3'));

    await rawHook(hookTokenOf(id), { hook_event_name: 'PostToolUse', session_id: id, tool_name: 'Bash', tool_use_id: 'toolu_huge', tool_input: {}, tool_response: { stdout: 'q'.repeat(5 * 1024 * 1024) } });
    await postTodoHook(id, { tool_name: 'Bash', tool_use_id: 'toolu_big', tool_input: {}, tool_response: { stdout: 'q'.repeat(900 * 1024) } });
    const after = Math.min(await hookLatencyMs('4'), await hookLatencyMs('5'));

    const retained = inspect(tracker, { depth: 8, maxStringLength: Infinity, maxArrayLength: Infinity });
    expect(retained).not.toContain('qqqqqqqq');
    expect(after).toBeLessThan(before * 10 + 100);
  });

  it('answers a todo hook against a 30 000-line transcript in the time of a hook against none (the hook never waits on the read)', async () => {
    const idWithHistory = await createSession('History');
    const idWithout = await createSession('None');
    const filler = Array.from({ length: 30_000 }, (_, index) => JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: `line ${index}` }] } }));
    writeTranscript(idWithHistory, filler);
    const medianHookLatencyMs = async (id: string, prefix: string) => {
      const latencies: number[] = [];
      for (let call = 0; call < 7; call += 1) {
        const start = performance.now();
        await postTodoHook(id, createHook(`${prefix}${call}`, String(call + 1), 'A todo'));
        latencies.push(performance.now() - start);
      }
      return latencies.sort((a, b) => a - b)[3]!;
    };

    const withoutHistory = await medianHookLatencyMs(idWithout, 'n');
    const withHistory = await medianHookLatencyMs(idWithHistory, 'h');

    expect(withHistory).toBeLessThan(withoutHistory * 5 + 100);
  });

  it('answers 200 and ignores a hook body over 1 MiB, instead of a 4xx that would surface in the CLI', async () => {
    const id = await createSession();

    const response = await rawHook(hookTokenOf(id), { hook_event_name: 'PostToolUse', session_id: id, tool_name: 'Bash', tool_use_id: 'toolu_huge', tool_input: {}, tool_response: { stdout: 'q'.repeat(5 * 1024 * 1024) } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  });

  it('still answers 4xx for an oversized body on another route', async () => {
    const response = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 1) }) });

    expect(response.status).toBe(413);
  });
});

describe('forged hook bodies for a todo tool', () => {
  it('answers 200 and keeps the list bounded for a TaskList of 50 000 entries, a subject that is an object and a tool_use_id of 1 MiB', async () => {
    const id = await createSession();
    const hugeList = Array.from({ length: 50_000 }, (_, index) => ({ id: index + 1 }));

    const answers = [
      await postTodoHook(id, { tool_name: 'TaskList', tool_use_id: 'toolu_list', tool_input: {}, tool_response: { tasks: hugeList } }),
      await postTodoHook(id, { tool_name: 'TaskCreate', tool_use_id: 'toolu_obj', tool_input: { subject: { not: 'text' } }, tool_response: { task: { id: { not: 'an id' } } } }),
      await postTodoHook(id, { tool_name: 'TaskCreate', tool_use_id: 't'.repeat(1024 * 1024 - 2000), tool_input: { subject: 'x' }, tool_response: { task: { id: '1' } } }),
      await postTodoHook(id, { tool_name: 'TaskUpdate', tool_use_id: 'toolu_proto', tool_input: { taskId: '__proto__', status: 'completed' }, tool_response: { success: true, taskId: '__proto__' } }),
    ];
    const todos = await getTodos(id);

    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200]);
    expect(todos.items.length).toBeLessThanOrEqual(100);
    expect(Object.prototype).not.toHaveProperty('status');
  });

  it('never folds a call for a session whose hook carries another session transcript path, but the hook fold still applies', async () => {
    const id = await createSession();
    const other = await createSession('Other');
    writeTranscript(other, transcriptCreate('toolu_other', '1', 'Belongs to the other session'));

    await rawHook(hookTokenOf(id), { hook_event_name: 'PostToolUse', session_id: id, transcript_path: transcriptOf(other), ...createHook('toolu_mine', '1', 'Mine') });
    await rawHook(hookTokenOf(id), { hook_event_name: 'Stop', session_id: id, transcript_path: transcriptOf(other) });

    expect(rowsOf(await getTodos(id))).toEqual(['1:pending:Mine']);
  });
});
