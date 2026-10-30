import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Session } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const MINUTE_MS = 60_000;
const SILENCE_DELAY_MS = 10 * MINUTE_MS;
const SILENCE_LINE_PREFIX = '[scheduled event "silence_check"';
const MANAGER_SPEC = { childrenCap: 2, mission: 'Lead the fleet', pulseSeconds: 3600 };

interface ArmedTimer { callback: () => void; delayMs: number; isCancelled: boolean }

const directories = createTempDirTracker();
let config: Config;
let daemon: Daemon;
let clients: Client[];
let armedTimers: ArmedTimer[];
let nowMs: number;
let leadId: string;
let workerId: string;

const schedule = (callback: () => void, delayMs: number) => {
  const timer: ArmedTimer = { callback, delayMs, isCancelled: false };
  armedTimers.push(timer);
  return () => { timer.isCancelled = true; };
};
const livingTimers = () => armedTimers.filter((timer) => !timer.isCancelled);
const fireLivingTimers = () => { for (const timer of livingTimers()) timer.callback(); };
const makeChildStateOld = () => daemon.db.prepare('UPDATE sessions SET state_since = ? WHERE id = ?').run(new Date(nowMs - 30 * MINUTE_MS).toISOString(), workerId);

const bootDaemon = async () => {
  armedTimers = [];
  clients = [];
  daemon = await startDaemon(config, {
    claudeConfigPath: join(config.home, 'harness-config.json'),
    power: { api: { acquire: () => ({ release: () => {}}) } },
    childSilence: { schedule, clock: () => nowMs },
  });
};
const stopDaemon = async () => {
  for (const client of clients) await client.close();
  await daemon.close();
};
const restartDaemon = async ({ stoppedForMs, whileStopped = () => {} }: { stoppedForMs: number; whileStopped?: (db: DatabaseSync) => void }) => {
  await stopDaemon();
  whileStopped(daemon.db);
  daemon.db.close();
  nowMs += stoppedForMs;
  await bootDaemon();
};

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...(init.headers ?? {}) } });
const createSession = async (name: string, extra: Record<string, unknown> = {}) => {
  const directory = join(config.home, name);
  mkdirSync(directory);
  const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory, name, harness: 'fake', emoji: '🤖', ...extra }) });
  return ((await created.json()) as Session).id;
};
const connect = async (sessionId: string) => {
  const { mcp_token } = daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string };
  const client = new Client({ name: 'child-silence-restart', version: '1' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${mcp_token}` } } }));
  return client;
};
const callTool = async (client: Client, name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  return (result as { content: { text: string }[] }).content[0]!.text;
};

const managerMessagesChild = async () => callTool(await connect(leadId), 'send_session_message', { target_uuid: workerId, body: 'status?' });
const childAnswersManager = async () => callTool(await connect(workerId), 'message_parent', { body: 'on it' });
const silenceLinesToLead = () =>
  (daemon.db.prepare('SELECT body FROM message_queue WHERE session_id = ?').all(leadId) as { body: string }[])
    .map((row) => row.body).filter((body) => body.startsWith(SILENCE_LINE_PREFIX));
const storedSilenceChecks = () => daemon.db.prepare('SELECT child_id, manager_id FROM child_silence_checks').all();
const letUserCloseWhileDaemonIsStopped = (sessionId: string) => (db: DatabaseSync) =>
  db.prepare("DELETE FROM session_events WHERE session_id = ? AND kind = 'daemon_shutdown'").run(sessionId);

beforeEach(async () => {
  config = loadConfig({ OPENFLEET_HOME: directories.make('child-silence-restart-'), OPENFLEET_PORT: '0', OPENFLEET_E2E: '1' });
  nowMs = Date.parse('2026-10-30T10:00:00.000Z');
  await bootDaemon();
  leadId = await createSession('Lead', { manager: MANAGER_SPEC });
  workerId = await createSession('Worker');
  daemon.db.prepare('UPDATE sessions SET parent_id = ? WHERE id = ?').run(leadId, workerId);
});
afterEach(async () => {
  await stopDaemon();
  daemon.db.close();
  directories.removeAll();
});

describe('the silence check when the daemon restarts while a child stays silent', () => {
  it('wakes the manager at the time that remained when the daemon restarts before the deadline', async () => {
    await managerMessagesChild();

    await restartDaemon({ stoppedForMs: 4 * MINUTE_MS });

    expect(livingTimers().map((timer) => timer.delayMs)).toEqual([SILENCE_DELAY_MS - 4 * MINUTE_MS]);
    nowMs += SILENCE_DELAY_MS - 4 * MINUTE_MS;
    fireLivingTimers();
    const [line] = silenceLinesToLead();
    expect(silenceLinesToLead()).toHaveLength(1);
    expect(line).toContain(workerId);
    expect(line).toMatch(/10 min/);
  });

  it('wakes the manager once, at boot, with the real age when the deadline passed while the daemon was stopped', async () => {
    await managerMessagesChild();

    await restartDaemon({ stoppedForMs: 25 * MINUTE_MS });

    expect(livingTimers().map((timer) => timer.delayMs)).toEqual([0]);
    fireLivingTimers();
    fireLivingTimers();
    expect(silenceLinesToLead()).toHaveLength(1);
    expect(silenceLinesToLead()[0]).toMatch(/25 min/);
    expect(storedSilenceChecks()).toEqual([]);
  });

  it('does not wake the manager again at the boot that follows the wake', async () => {
    await managerMessagesChild();
    await restartDaemon({ stoppedForMs: 25 * MINUTE_MS });
    fireLivingTimers();

    await restartDaemon({ stoppedForMs: MINUTE_MS });

    expect(livingTimers()).toEqual([]);
    expect(silenceLinesToLead()).toHaveLength(1);
  });

  it('forgets the check of a child that was closed while the daemon was stopped', async () => {
    await managerMessagesChild();

    await restartDaemon({ stoppedForMs: 4 * MINUTE_MS, whileStopped: letUserCloseWhileDaemonIsStopped(workerId) });

    expect(livingTimers()).toEqual([]);
    expect(storedSilenceChecks()).toEqual([]);
  });

  it('forgets the check of a manager that was closed while the daemon was stopped', async () => {
    await managerMessagesChild();

    await restartDaemon({ stoppedForMs: 4 * MINUTE_MS, whileStopped: letUserCloseWhileDaemonIsStopped(leadId) });

    expect(livingTimers()).toEqual([]);
    expect(storedSilenceChecks()).toEqual([]);
  });

  it('forgets the check of a child that answered before the daemon stopped', async () => {
    await managerMessagesChild();
    await childAnswersManager();

    await restartDaemon({ stoppedForMs: 25 * MINUTE_MS });

    expect(storedSilenceChecks()).toEqual([]);
    expect(livingTimers()).toEqual([]);
    expect(silenceLinesToLead()).toEqual([]);
  });

  it('keeps one deadline when the manager messages the child again after the restart', async () => {
    await managerMessagesChild();
    await restartDaemon({ stoppedForMs: 4 * MINUTE_MS });

    await managerMessagesChild();

    expect(livingTimers().map((timer) => timer.delayMs)).toEqual([SILENCE_DELAY_MS]);
    expect(storedSilenceChecks()).toHaveLength(1);
    nowMs += SILENCE_DELAY_MS;
    makeChildStateOld();
    fireLivingTimers();
    expect(silenceLinesToLead()).toHaveLength(1);
  });
});
