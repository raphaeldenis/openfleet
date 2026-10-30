import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '@openfleet/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { FakeHarness, type FakeHandle } from '../harness/fakeHarness.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { CHILD_RESTART_DELAYS_MS, CHILD_RESTART_WINDOW_MS } from './childAutoRestarter.js';

const tempDirs = createTempDirTracker();
const openClients: Client[] = [];

const textOf = (result: unknown): string => (result as { content: { text: string }[] }).content[0]!.text;

interface ScheduledRestart { callback: () => void; delayMs: number; isCancelled: boolean }

let config: Config;
let daemon: Daemon;
let fakeHarness: FakeHarness;
let nowMs: number;
let scheduledRestarts: ScheduledRestart[];
let spawnedChildCount = 0;

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...(init.headers ?? {}) } });

const aManager = async ({ childrenCap = 3, childAutoRestart = true, isSleeping = false }: { childrenCap?: number; childAutoRestart?: boolean; isSleeping?: boolean } = {}) => {
  const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', harness: 'fake', emoji: '🧭', name: 'Lead', manager: { pulseSeconds: 3600, childrenCap, mission: 'Ship the fleet' } }) });
  const { id } = (await created.json()) as { id: string };
  await api(`/api/managers/${id}`, { method: 'PATCH', body: JSON.stringify({ childAutoRestart }) });
  if (isSleeping) await api(`/api/managers/${id}`, { method: 'PATCH', body: JSON.stringify({ pulseEnabled: false }) });
  const { mcp_token } = daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(id) as { mcp_token: string };
  const client = new Client({ name: 'child-auto-restart', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcp_token}` } } }));
  openClients.push(client);
  await client.callTool({ name: 'get_manager_base', arguments: {} });
  return { id, client };
};

const spawnChild = async (client: Client): Promise<{ childId: string; isError: boolean; text: string }> => {
  spawnedChildCount += 1;
  const name = `restart-child-${spawnedChildCount}`;
  const directory = join(config.worktreesRoot, name);
  mkdirSync(directory, { recursive: true });
  const result = await client.callTool({ name: 'create_session', arguments: { directory, name } });
  const text = textOf(result);
  return { isError: result.isError === true, text, childId: result.isError ? '' : (JSON.parse(text) as { id: string }).id };
};

const latestHandleOf = (sessionId: string): FakeHandle => {
  const launchIndex = fakeHarness.launches.map((launch) => launch.sessionId).lastIndexOf(sessionId);
  return fakeHarness.handles[launchIndex]!;
};
const launchCountOf = (sessionId: string) => fakeHarness.launches.filter((launch) => launch.sessionId === sessionId).length;
const stateOf = (sessionId: string) => (daemon.db.prepare('SELECT state FROM sessions WHERE id = ?').get(sessionId) as { state: string }).state;
const messageBodiesOf = (sessionId: string) => (daemon.db.prepare('SELECT body FROM message_queue WHERE session_id = ? ORDER BY created_at').all(sessionId) as { body: string }[]).map((row) => row.body);

/** The child's process dies on its own after having printed something: a crash, not a failed start. */
const crashAfterOutput = (childId: string, exitCode = 137) => {
  const handle = latestHandleOf(childId);
  handle.emitData('working…');
  handle.emitExit(exitCode);
};
const runNextScheduledRestart = () => {
  const restart = scheduledRestarts.find((candidate) => !candidate.isCancelled)!;
  restart.isCancelled = true;
  restart.callback();
};
const pendingRestarts = () => scheduledRestarts.filter((restart) => !restart.isCancelled);

beforeAll(async () => {
  config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-child-restart-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  nowMs = Date.parse('2026-10-29T10:00:00.000Z');
  scheduledRestarts = [];
  daemon = await startDaemon(config, {
    childRestart: {
      clock: () => nowMs,
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

describe('a child that crashes on its own', () => {
  it.each([
    { managerMode: 'watching', isSleeping: false },
    { managerMode: 'sleeping', isSleeping: true },
  ])('is restarted after the first delay when the option is on and the manager is $managerMode', async ({ isSleeping }) => {
    const { id: managerId, client } = await aManager({ isSleeping });
    const { childId } = await spawnChild(client);

    crashAfterOutput(childId);
    expect(stateOf(childId)).toBe('closed');
    expect(pendingRestarts().map((restart) => restart.delayMs)).toEqual([CHILD_RESTART_DELAYS_MS[0]]);
    runNextScheduledRestart();

    expect(stateOf(childId)).not.toBe('closed');
    expect(launchCountOf(childId)).toBe(2);
    expect(latestHandleOf(childId)).not.toBe(undefined);
    expect(messageBodiesOf(managerId).some((body) => body.startsWith('[child_restarted]'))).toBe(true);
  });

  it('is never restarted when it is an arbiter: the arbiter runner replaces a lost arbiter itself', async () => {
    const { client } = await aManager();
    const { childId } = await spawnChild(client);
    daemon.db.prepare("UPDATE sessions SET role = 'arbiter' WHERE id = ?").run(childId);

    crashAfterOutput(childId);

    expect(pendingRestarts()).toEqual([]);
    expect(stateOf(childId)).toBe('closed');
    expect(launchCountOf(childId)).toBe(1);
  });

  it('stays closed when the option is off', async () => {
    const { client } = await aManager({ childAutoRestart: false });
    const { childId } = await spawnChild(client);

    crashAfterOutput(childId);

    expect(pendingRestarts()).toEqual([]);
    expect(stateOf(childId)).toBe('closed');
    expect(launchCountOf(childId)).toBe(1);
  });

  it('stays closed when its parent closed it', async () => {
    const { client } = await aManager();
    const { childId } = await spawnChild(client);

    await client.callTool({ name: 'close_session', arguments: { session_id: childId } });

    expect(pendingRestarts()).toEqual([]);
    expect(stateOf(childId)).toBe('closed');
    expect(launchCountOf(childId)).toBe(1);
  });

  it('is never restarted when the process exited right after launch without a single byte of output, and the manager is told', async () => {
    const { id: managerId, client } = await aManager();
    const { childId } = await spawnChild(client);

    latestHandleOf(childId).emitExit(1);

    expect(pendingRestarts()).toEqual([]);
    expect(stateOf(childId)).toBe('closed');
    expect(launchCountOf(childId)).toBe(1);
    expect(messageBodiesOf(managerId).some((body) => body.startsWith('[harness_exited]'))).toBe(true);
  });

  it('counts as an active child of the manager while its restart is pending', async () => {
    const { client } = await aManager({ childrenCap: 1 });
    const { childId } = await spawnChild(client);

    crashAfterOutput(childId);
    const spawnWhilePending = await spawnChild(client);

    expect(spawnWhilePending.isError).toBe(true);
    expect(spawnWhilePending.text).toContain('children_cap');
    runNextScheduledRestart();
  });

  it('shows restartPending to the manager and the API while the restart waits, and no longer once it ran', async () => {
    const { client } = await aManager();
    const { childId } = await spawnChild(client);
    const restartPendingSeenByManager = async () => {
      const status = JSON.parse(textOf(await client.callTool({ name: 'get_argus_status', arguments: {} }))) as { children: { id: string; restartPending?: boolean }[] };
      return status.children.find((child) => child.id === childId)?.restartPending === true;
    };
    const restartPendingSeenByApi = async () => ((await (await api(`/api/sessions/${childId}`)).json()) as { restartPending?: boolean }).restartPending === true;

    crashAfterOutput(childId);
    const whileWaiting = { manager: await restartPendingSeenByManager(), api: await restartPendingSeenByApi() };
    runNextScheduledRestart();
    const afterRestart = { manager: await restartPendingSeenByManager(), api: await restartPendingSeenByApi() };

    expect(whileWaiting).toEqual({ manager: true, api: true });
    expect(afterRestart).toEqual({ manager: false, api: false });
  });

  it('is restarted with growing delays up to the cap, then stays closed and the manager is told it is exhausted', async () => {
    const { id: managerId, client } = await aManager();
    const { childId } = await spawnChild(client);

    const delaysSeen: number[] = [];
    for (let crash = 0; crash < CHILD_RESTART_DELAYS_MS.length; crash += 1) {
      crashAfterOutput(childId);
      delaysSeen.push(pendingRestarts()[0]!.delayMs);
      runNextScheduledRestart();
    }
    crashAfterOutput(childId);

    expect(delaysSeen).toEqual([...CHILD_RESTART_DELAYS_MS]);
    expect(pendingRestarts()).toEqual([]);
    expect(stateOf(childId)).toBe('closed');
    expect(launchCountOf(childId)).toBe(1 + CHILD_RESTART_DELAYS_MS.length);
    expect(messageBodiesOf(managerId).some((body) => body.startsWith('[child_restart_exhausted]'))).toBe(true);
  });

  it('is restarted again once the earlier restarts left the sliding window', async () => {
    const { client } = await aManager();
    const { childId } = await spawnChild(client);
    for (let crash = 0; crash < CHILD_RESTART_DELAYS_MS.length; crash += 1) {
      crashAfterOutput(childId);
      runNextScheduledRestart();
    }

    nowMs += CHILD_RESTART_WINDOW_MS + 1;
    crashAfterOutput(childId);

    expect(pendingRestarts().map((restart) => restart.delayMs)).toEqual([CHILD_RESTART_DELAYS_MS[0]]);
  });

  it('is not restarted when it was reopened by someone else before the delay elapsed', async () => {
    const { client } = await aManager();
    const { childId } = await spawnChild(client);
    crashAfterOutput(childId);

    await api(`/api/sessions/${childId}/reopen`, { method: 'POST', body: JSON.stringify({ mode: 'resume' }) });
    runNextScheduledRestart();

    expect(launchCountOf(childId)).toBe(2);
  });
});

describe('a child closed on purpose while its restart waits', () => {
  const restartPendingSeenByApi = async (childId: string) => ((await (await api(`/api/sessions/${childId}`)).json()) as { restartPending?: boolean }).restartPending === true;
  const runEveryScheduledCallbackEvenIfCancelled = () => scheduledRestarts.forEach((restart) => restart.callback());
  const expectNoRestartEver = async ({ managerId, childId }: { managerId: string; childId: string }) => {
    expect(pendingRestarts()).toEqual([]);
    expect(await restartPendingSeenByApi(childId)).toBe(false);
    runEveryScheduledCallbackEvenIfCancelled();
    expect(stateOf(childId)).toBe('closed');
    expect(launchCountOf(childId)).toBe(1);
    expect(messageBodiesOf(managerId).filter((body) => body.startsWith('[child_restart'))).toEqual([]);
  };

  it('is not restarted when its parent closes it through close_session', async () => {
    const { id: managerId, client } = await aManager();
    const { childId } = await spawnChild(client);
    crashAfterOutput(childId);

    const result = await client.callTool({ name: 'close_session', arguments: { session_id: childId } });

    expect(textOf(result)).toContain(childId);
    await expectNoRestartEver({ managerId, childId });
  });

  it('is not restarted when a human closes it through POST /api/sessions/:id/close', async () => {
    const { id: managerId, client } = await aManager();
    const { childId } = await spawnChild(client);
    crashAfterOutput(childId);

    const response = await api(`/api/sessions/${childId}/close`, { method: 'POST' });

    expect(response.status).toBe(200);
    await expectNoRestartEver({ managerId, childId });
  });

  it('is not restarted when its manager closed during the delay', async () => {
    const { id: managerId, client } = await aManager();
    const { childId } = await spawnChild(client);
    crashAfterOutput(childId);

    await api(`/api/sessions/${managerId}/close`, { method: 'POST' });
    runNextScheduledRestart();

    expect(stateOf(childId)).toBe('closed');
    expect(launchCountOf(childId)).toBe(1);
    expect(await restartPendingSeenByApi(childId)).toBe(false);
  });

  it('frees its slot under the children cap once closed on purpose', async () => {
    const { client } = await aManager({ childrenCap: 1 });
    const { childId } = await spawnChild(client);
    crashAfterOutput(childId);
    await client.callTool({ name: 'close_session', arguments: { session_id: childId } });

    const spawnAfterClose = await spawnChild(client);

    expect(spawnAfterClose.isError).toBe(false);
  });
});
