import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON, type ManagerView } from '@openfleet/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { FakeHarness, type FakeHandle } from '../harness/fakeHarness.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { SLEEP_HANDOFF_TEXT } from './sleepHandoff.js';

const tempDirs = createTempDirTracker();
const openClients: Client[] = [];

const textOf = (result: unknown): string => (result as { content: { text: string }[] }).content[0]!.text;

interface ScheduledRestart { callback: () => void; delayMs: number; isCancelled: boolean }

let config: Config;
let daemon: Daemon;
let fakeHarness: FakeHarness;
let scheduledRestarts: ScheduledRestart[];
let spawnedChildCount = 0;

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...(init.headers ?? {}) } });
const patchManager = (managerId: string, body: unknown) => api(`/api/managers/${managerId}`, { method: 'PATCH', body: JSON.stringify(body) });
const managerViewOf = async (managerId: string): Promise<ManagerView> => ((await (await api(`/api/managers/${managerId}`)).json()) as { manager: ManagerView }).manager;

const postHook = async (sessionId: string, body: Record<string, unknown>) => {
  const { hook_token } = daemon.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(sessionId) as { hook_token: string };
  await fetch(`${daemon.server.url}/hooks/${hook_token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'cli', ...body }) });
};
const startsUp = (sessionId: string) => postHook(sessionId, { hook_event_name: 'SessionStart', source: 'startup' });
const startsTurn = (sessionId: string) => postHook(sessionId, { hook_event_name: 'UserPromptSubmit' });
const endsTurn = (sessionId: string) => postHook(sessionId, { hook_event_name: 'Stop', stop_hook_active: true });

const aManager = async ({ childAutoRestart = false }: { childAutoRestart?: boolean } = {}) => {
  const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', harness: 'fake', emoji: '🧭', name: 'Lead', manager: { pulseSeconds: 3600, childrenCap: 3, mission: 'Ship the fleet' } }) });
  const { id } = (await created.json()) as { id: string };
  await startsUp(id);
  if (childAutoRestart) await patchManager(id, { childAutoRestart });
  const { mcp_token } = daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(id) as { mcp_token: string };
  const client = new Client({ name: 'manager-mode', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcp_token}` } } }));
  openClients.push(client);
  await client.callTool({ name: 'get_manager_base', arguments: {} });
  return { id, client };
};

const spawnChild = async (client: Client): Promise<string> => {
  spawnedChildCount += 1;
  const name = `mode-child-${spawnedChildCount}`;
  const directory = join(config.worktreesRoot, name);
  mkdirSync(directory, { recursive: true });
  const result = await client.callTool({ name: 'create_session', arguments: { directory, name } });
  return (JSON.parse(textOf(result)) as { id: string }).id;
};

const latestHandleOf = (sessionId: string): FakeHandle => {
  const launchIndex = fakeHarness.launches.map((launch) => launch.sessionId).lastIndexOf(sessionId);
  return fakeHarness.handles[launchIndex]!;
};
const launchCountOf = (sessionId: string) => fakeHarness.launches.filter((launch) => launch.sessionId === sessionId).length;
const stateOf = (sessionId: string) => (daemon.db.prepare('SELECT state FROM sessions WHERE id = ?').get(sessionId) as { state: string }).state;
const queueRowsOf = (sessionId: string) => daemon.db.prepare('SELECT body, status FROM message_queue WHERE session_id = ? ORDER BY created_at').all(sessionId) as { body: string; status: string }[];
const sleepRowsOf = (sessionId: string) => queueRowsOf(sessionId).filter((row) => row.body.startsWith('[sleep]'));
const typedBodiesOf = (sessionId: string) => latestHandleOf(sessionId).written;
const sendHumanMessage = (sessionId: string, body: string) => api(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
const crashAfterOutput = (childId: string) => {
  latestHandleOf(childId).emitData('working…');
  latestHandleOf(childId).emitExit(137);
};
const runNextScheduledRestart = () => {
  const restart = scheduledRestarts.find((candidate) => !candidate.isCancelled)!;
  restart.isCancelled = true;
  restart.callback();
};
const pendingRestarts = () => scheduledRestarts.filter((restart) => !restart.isCancelled);

beforeAll(async () => {
  config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-manager-mode-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  scheduledRestarts = [];
  daemon = await startDaemon(config, {
    childRestart: {
      clock: () => Date.parse('2026-10-29T10:00:00.000Z'),
      schedule: (callback, delayMs) => {
        const restart: ScheduledRestart = { callback, delayMs, isCancelled: false };
        scheduledRestarts.push(restart);
        return () => { restart.isCancelled = true; };
      },
    },
  });
  fakeHarness = daemon.harnesses.find((harness) => harness instanceof FakeHarness) as FakeHarness;
});
beforeEach(() => {
  scheduledRestarts.length = 0;
});
afterAll(async () => {
  await Promise.all(openClients.map((client) => client.close()));
  await daemon.close();
  tempDirs.removeAll();
});

describe('the mode of a manager through PATCH /api/managers/:id', () => {
  it('starts watching, and reports the mode with the handoff fields', async () => {
    const { id } = await aManager();

    const view = await managerViewOf(id);

    expect(view).toMatchObject({ mode: 'watching', pulseEnabled: true, sleepHandoffPending: false });
  });

  it.each(['sleeping', 'disabled', 'watching'] as const)('switches to %s and keeps pulseEnabled true only while watching', async (mode) => {
    const { id } = await aManager();

    const response = await patchManager(id, { mode });

    expect(response.status).toBe(200);
    expect(await managerViewOf(id)).toMatchObject({ mode, pulseEnabled: mode === 'watching' });
  });

  it('refuses an unknown mode with 400 invalid_mode and changes nothing', async () => {
    const { id } = await aManager();

    const response = await patchManager(id, { mode: 'napping' });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_mode' });
    expect((await managerViewOf(id)).mode).toBe('watching');
  });

  it('reads the pause alias as sleeping and the resume alias as watching', async () => {
    const { id } = await aManager();

    await patchManager(id, { pulseEnabled: false });
    const afterPause = (await managerViewOf(id)).mode;
    await patchManager(id, { pulseEnabled: true });
    const afterResume = (await managerViewOf(id)).mode;

    expect({ afterPause, afterResume }).toEqual({ afterPause: 'sleeping', afterResume: 'watching' });
  });

  it('keeps a disabled manager disabled when it is paused', async () => {
    const { id } = await aManager();
    await patchManager(id, { mode: 'disabled' });

    await patchManager(id, { pulseEnabled: false });

    expect((await managerViewOf(id)).mode).toBe('disabled');
  });

  it('is not exposed as an MCP tool, and get_argus_status reports the mode', async () => {
    const { id, client } = await aManager();
    await patchManager(id, { mode: 'sleeping' });

    const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
    const status = JSON.parse(textOf(await client.callTool({ name: 'get_argus_status', arguments: {} }))) as { manager: { mode: string } };

    expect(toolNames.filter((name) => name.includes('mode'))).toEqual([]);
    expect(status.manager.mode).toBe('sleeping');
  });
});

describe('the [sleep] message', () => {
  it('is queued exactly once when the manager switches to sleeping', async () => {
    const { id } = await aManager();

    await patchManager(id, { mode: 'sleeping' });

    expect(sleepRowsOf(id).map((row) => row.body)).toEqual([SLEEP_HANDOFF_TEXT]);
  });

  it('is typed to the manager and recorded as delivered', async () => {
    const { id } = await aManager();

    await patchManager(id, { mode: 'sleeping' });
    await vi.waitFor(() => expect(typedBodiesOf(id).some((body) => body.startsWith('[sleep]'))).toBe(true));
    await startsTurn(id);

    await vi.waitFor(async () => expect(await managerViewOf(id)).toMatchObject({ sleepHandoffPending: false, sleepHandoffDeliveredAt: expect.any(String) }));
    expect(typedBodiesOf(id).filter((body) => body.startsWith('[sleep]'))).toHaveLength(1);
  });

  it('is not repeated by a second switch to sleeping or by another profile update', async () => {
    const { id } = await aManager();
    await patchManager(id, { mode: 'sleeping' });

    await patchManager(id, { mode: 'sleeping' });
    await patchManager(id, { pulseEnabled: false });
    await patchManager(id, { expertise: 'Keeps the fleet moving' });

    expect(sleepRowsOf(id)).toHaveLength(1);
  });

  it('is sent again, as a new message, when the manager sleeps again after watching', async () => {
    const { id } = await aManager();
    await patchManager(id, { mode: 'sleeping' });
    await vi.waitFor(() => expect(sleepRowsOf(id).map((row) => row.status)).toEqual(['delivered']));
    await patchManager(id, { mode: 'watching' });

    await patchManager(id, { mode: 'sleeping' });

    expect(sleepRowsOf(id)).toHaveLength(2);
  });

  it('is not sent when the manager switches to disabled, and not owed any more once it left sleeping', async () => {
    const { id } = await aManager();
    await patchManager(id, { mode: 'disabled' });

    expect(sleepRowsOf(id)).toEqual([]);
    expect((await managerViewOf(id)).sleepHandoffPending).toBe(false);
  });

  it('waits behind the running turn: it is never typed in the middle of it', async () => {
    const { id } = await aManager();
    await sendHumanMessage(id, 'work on the plan');
    await vi.waitFor(() => expect(latestHandleOf(id).submitted).toContain('work on the plan'));
    await startsTurn(id);

    await patchManager(id, { mode: 'sleeping' });
    const whileTurnRuns = { rows: sleepRowsOf(id).map((row) => row.status), typed: typedBodiesOf(id).some((body) => body.startsWith('[sleep]')) };
    await endsTurn(id);

    expect(whileTurnRuns).toEqual({ rows: ['queued'], typed: false });
    await vi.waitFor(() => expect(typedBodiesOf(id).some((body) => body.startsWith('[sleep]'))).toBe(true));
  });

  const hasTypedSleep = (sessionId: string) => typedBodiesOf(sessionId).some((body) => body.startsWith('[sleep]'));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
  const aManagerInARunningTurn = async () => {
    const { id } = await aManager();
    await sendHumanMessage(id, 'work on the plan');
    await vi.waitFor(() => expect(latestHandleOf(id).submitted).toContain('work on the plan'));
    await startsTurn(id);
    return id;
  };

  it('is cancelled when the manager wakes up before the running turn ends', async () => {
    const id = await aManagerInARunningTurn();
    await patchManager(id, { mode: 'sleeping' });
    await patchManager(id, { mode: 'watching' });

    await endsTurn(id);
    await settle();

    expect({ typed: hasTypedSleep(id), rows: sleepRowsOf(id) }).toEqual({ typed: false, rows: [] });
  });

  it('is not typed to a manager that went sleeping, disabled, then watching again', async () => {
    const id = await aManagerInARunningTurn();
    await patchManager(id, { mode: 'sleeping' });
    await patchManager(id, { mode: 'disabled' });
    await patchManager(id, { mode: 'watching' });

    await endsTurn(id);
    await settle();

    expect({ typed: hasTypedSleep(id), rows: sleepRowsOf(id) }).toEqual({ typed: false, rows: [] });
  });

  it('is not delivered when a manager closed while sleeping wakes up and is reopened', async () => {
    const { id } = await aManager();
    await api(`/api/sessions/${id}/close`, { method: 'POST' });
    await patchManager(id, { mode: 'sleeping' });
    await patchManager(id, { mode: 'watching' });

    await api(`/api/sessions/${id}/reopen`, { method: 'POST', body: JSON.stringify({ mode: 'resume' }) });
    await startsUp(id);
    await settle();

    expect({ typed: hasTypedSleep(id), rows: sleepRowsOf(id) }).toEqual({ typed: false, rows: [] });
  });

  it('is dropped, never typed, when it is still queued for a manager that is no longer sleeping', async () => {
    const id = await aManagerInARunningTurn();
    const staleHandoffId = `handoff:${id}:2026-10-29T09:00:00.000Z`;
    daemon.db.prepare("INSERT INTO message_queue (id, session_id, body, status, created_at) VALUES (?, ?, ?, 'queued', ?)").run(staleHandoffId, id, SLEEP_HANDOFF_TEXT, new Date().toISOString());

    await endsTurn(id);
    await settle();

    expect({ typed: hasTypedSleep(id), rows: sleepRowsOf(id) }).toEqual({ typed: false, rows: [] });
  });

  it('is still typed after the running turn when the manager re-enters sleeping meanwhile', async () => {
    const id = await aManagerInARunningTurn();
    await patchManager(id, { mode: 'sleeping' });
    await patchManager(id, { mode: 'sleeping' });

    await endsTurn(id);

    await vi.waitFor(() => expect(hasTypedSleep(id)).toBe(true));
    expect(typedBodiesOf(id).filter((body) => body.startsWith('[sleep]'))).toHaveLength(1);
  });

  it('is typed once, as the new message and never the old one, when the manager goes sleeping, watching, sleeping during the running turn', async () => {
    const id = await aManagerInARunningTurn();
    await patchManager(id, { mode: 'sleeping' });
    const firstHandoffId = (daemon.db.prepare("SELECT id FROM message_queue WHERE session_id = ? AND body LIKE '[sleep]%'").get(id) as { id: string }).id;
    await patchManager(id, { mode: 'watching' });
    await settle();
    await patchManager(id, { mode: 'sleeping' });

    await endsTurn(id);

    await vi.waitFor(() => expect(hasTypedSleep(id)).toBe(true));
    await settle();
    const secondHandoffIds = daemon.db.prepare("SELECT id FROM message_queue WHERE session_id = ? AND body LIKE '[sleep]%'").all(id).map((row) => (row as { id: string }).id);
    expect(typedBodiesOf(id).filter((body) => body.startsWith('[sleep]'))).toHaveLength(1);
    expect(secondHandoffIds).toHaveLength(1);
    expect(secondHandoffIds).not.toContain(firstHandoffId);
  });

  it('stays owed to a closed manager and is queued once, when the manager is reopened', async () => {
    const { id } = await aManager();
    await api(`/api/sessions/${id}/close`, { method: 'POST' });

    await patchManager(id, { mode: 'sleeping' });
    const whileClosed = { rows: sleepRowsOf(id).length, view: await managerViewOf(id) };
    await api(`/api/sessions/${id}/reopen`, { method: 'POST', body: JSON.stringify({ mode: 'resume' }) });
    await startsUp(id);

    expect(whileClosed.rows).toBe(0);
    expect(whileClosed.view.sleepHandoffPending).toBe(true);
    expect(sleepRowsOf(id)).toHaveLength(1);
  });
});

describe('a sleeping manager', () => {
  it('receives a message from its child like a watching one: it is typed and the manager runs', async () => {
    const { id } = await aManager();
    await patchManager(id, { mode: 'sleeping' });
    await vi.waitFor(() => expect(latestHandleOf(id).submitted.some((body) => body.startsWith('[sleep]'))).toBe(true));
    await startsTurn(id);
    await endsTurn(id);

    await sendHumanMessage(id, '[from child] the build is green');

    await vi.waitFor(() => expect(typedBodiesOf(id)).toContain('[from child] the build is green'));
  });

  it('receives no timed pulse', async () => {
    const { id } = await aManager();
    await patchManager(id, { mode: 'sleeping' });

    const manualPulse = await api(`/api/managers/${id}/pulse`, { method: 'POST', body: '{}' });

    expect(manualPulse.status).toBe(409);
    expect(await manualPulse.json()).toMatchObject({ error: 'manager_paused' });
    expect(queueRowsOf(id).filter((row) => row.body.startsWith('[pulse]'))).toEqual([]);
  });
});

describe('a disabled manager', () => {
  it('holds a message in its queue, and types it once it is reactivated', async () => {
    const { id } = await aManager();
    await patchManager(id, { mode: 'disabled' });

    await sendHumanMessage(id, 'wake up when you are back');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const typedWhileDisabled = typedBodiesOf(id).includes('wake up when you are back');
    await patchManager(id, { mode: 'watching' });

    expect(typedWhileDisabled).toBe(false);
    expect(queueRowsOf(id).find((row) => row.body === 'wake up when you are back')).toBeDefined();
    await vi.waitFor(() => expect(typedBodiesOf(id)).toContain('wake up when you are back'));
  });

  it('replays the held messages in their order when it comes back sleeping as well', async () => {
    const { id } = await aManager();
    await patchManager(id, { mode: 'disabled' });
    await sendHumanMessage(id, 'first held');
    await sendHumanMessage(id, 'second held');

    await patchManager(id, { mode: 'sleeping' });

    await vi.waitFor(() => expect(typedBodiesOf(id)).toContain('first held'));
    const heldBodiesInQueueOrder = queueRowsOf(id).map((row) => row.body).filter((body) => body.endsWith(' held'));
    expect(heldBodiesInQueueOrder).toEqual(['first held', 'second held']);
  });

  it('does not restart a child that crashed, and restarts it once at reactivation', async () => {
    const { id, client } = await aManager({ childAutoRestart: true });
    const childId = await spawnChild(client);
    await patchManager(id, { mode: 'disabled' });

    crashAfterOutput(childId);
    const scheduledWhileDisabled = pendingRestarts().length;
    await patchManager(id, { mode: 'watching' });

    expect(scheduledWhileDisabled).toBe(0);
    expect(stateOf(childId)).toBe('closed');
    expect(pendingRestarts()).toHaveLength(1);
    runNextScheduledRestart();
    expect(launchCountOf(childId)).toBe(2);
  });

  it('does not restart a child that crashed, and keeps it closed once reactivated when the option is off', async () => {
    const { id, client } = await aManager();
    const childId = await spawnChild(client);
    await patchManager(id, { mode: 'disabled' });

    crashAfterOutput(childId);
    await patchManager(id, { mode: 'watching' });

    expect(pendingRestarts()).toEqual([]);
    expect(launchCountOf(childId)).toBe(1);
  });

  it('catches a missed crash up only once, however many times the manager is updated afterwards', async () => {
    const { id, client } = await aManager({ childAutoRestart: true });
    const childId = await spawnChild(client);
    await patchManager(id, { mode: 'disabled' });
    crashAfterOutput(childId);

    await patchManager(id, { mode: 'watching' });
    await patchManager(id, { expertise: 'Still here' });
    await patchManager(id, { expertise: 'Still here again' });

    expect(pendingRestarts()).toHaveLength(1);
  });
});

describe('the scheduled events of a manager', () => {
  const scheduleEventIn = async (client: Client, title: string) =>
    client.callTool({ name: 'schedule_argus_event', arguments: { message: 'check the build', title, in_minutes: 1 } });
  const dueNow = (managerId: string) => daemon.db.prepare("UPDATE argus_scheduled_events SET due_at = '2020-01-01T00:00:00.000Z' WHERE manager_id = ? AND status = 'pending'").run(managerId);
  const statusesOf = (managerId: string) => (daemon.db.prepare('SELECT status FROM argus_scheduled_events WHERE manager_id = ?').all(managerId) as { status: string }[]).map((row) => row.status);

  it('stay pending while the manager is disabled, and are delivered when it is reactivated', async () => {
    const { id, client } = await aManager();
    await scheduleEventIn(client, 'held');
    await patchManager(id, { mode: 'disabled' });

    dueNow(id);
    daemon.scheduledEvents.stop();
    daemon.scheduledEvents.start();
    const statusesWhileDisabled = statusesOf(id);
    await patchManager(id, { mode: 'watching' });

    expect(statusesWhileDisabled).toEqual(['pending']);
    expect(statusesOf(id)).toEqual(['delivered']);
    expect(queueRowsOf(id).some((row) => row.body.startsWith('[scheduled event'))).toBe(true);
  });

  it('are delivered to a sleeping manager', async () => {
    const { id, client } = await aManager();
    await scheduleEventIn(client, 'sleepy');
    await patchManager(id, { mode: 'sleeping' });

    dueNow(id);
    daemon.scheduledEvents.stop();
    daemon.scheduledEvents.start();

    expect(statusesOf(id)).toEqual(['delivered']);
  });
});
