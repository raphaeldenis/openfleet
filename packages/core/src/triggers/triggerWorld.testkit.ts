import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Session } from '@openfleet/shared';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { createTempDirTracker } from '../tempDirTracker.js';

export const PROJECT_ID = 'project-triggers';
export const MINUTE_MS = 60_000;
const MANAGER_SPEC = { childrenCap: 2, mission: 'Lead the fleet', pulseSeconds: 3600 };

export interface TriggerRecordView { id: string; contentRev: number; armedAt: string | null }
export interface FireRow { id: string; dedup_key: string; ledger_state: string; settle_reason: string | null; fired_at: string }

/** A real daemon on a throwaway home, with a fake clock, that can be stopped and started again on the same home the way a crash and a reboot do. */
export async function startTriggerWorld() {
  const directories = createTempDirTracker();
  const config: Config = loadConfig({ OPENFLEET_HOME: directories.make('trigger-world-'), OPENFLEET_PORT: '0', OPENFLEET_E2E: '1' });
  const clients: Client[] = [];
  // The state of a session is stamped by the real clock: the fake clock starts there, so a delay computed from `stateSince` stays coherent.
  let nowMs = Date.now();
  let daemon!: Daemon;
  const timers: { callback: () => void; delayMs: number; isCancelled: boolean }[] = [];
  const schedule = (callback: () => void, delayMs: number) => {
    const timer = { callback, delayMs, isCancelled: false };
    timers.push(timer);
    return () => { timer.isCancelled = true; };
  };
  const sockets: WebSocket[] = [];

  const boot = async () => {
    daemon = await startDaemon(config, {
      claudeConfigPath: join(config.home, 'harness-config.json'),
      power: { api: { acquire: () => ({ release: () => {} }) } },
      humanProof: { consume: () => true },
      triggers: { clock: () => nowMs, schedule },
    });
  };
  await boot();

  const api = (path: string, init: RequestInit = {}) => fetch(`${daemon.server.url}${path}`, {
    ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...(init.headers ?? {}) },
  });
  const json = async <T>(response: Response): Promise<T> => await response.json() as T;

  daemon.db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, 'Triggers', 'now')").run(PROJECT_ID);

  const createSession = async (name: string, extra: Record<string, unknown> = {}) => {
    const directory = join(config.home, name);
    mkdirSync(directory);
    const created = await json<Session>(await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory, name, harness: 'fake', emoji: '🤖', ...extra }) }));
    daemon.db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(PROJECT_ID, created.id);
    return created;
  };

  /** A trigger created through the REST API and armed with a human proof. */
  const createArmedTrigger = async (content: { title?: string; when?: unknown; conditions?: unknown[]; run: unknown; policy?: unknown }): Promise<string> => {
    const created = await json<TriggerRecordView>(await api('/api/triggers', { method: 'POST', body: JSON.stringify({ projectId: PROJECT_ID, ...content }) }));
    const armed = await api(`/api/triggers/${created.id}/arm`, { method: 'POST', body: JSON.stringify({ approvedRev: created.contentRev }), headers: { 'x-human-proof': 'proof' } });
    if (armed.status !== 200) throw new Error(`world: arming failed with ${armed.status} ${await armed.text()}`);
    return created.id;
  };

  /** A child session of a manager, in the project of the world. */
  const createChild = async (manager: Session, name = 'Child') => {
    const child = await createSession(name);
    daemon.db.prepare('UPDATE sessions SET parent_id = ? WHERE id = ?').run(manager.id, child.id);
    return child;
  };

  /** A hook of the harness, as the CLI posts it; this is how a session really changes state. */
  const postHook = async (sessionId: string, body: Record<string, unknown>) => {
    const { hook_token } = daemon.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(sessionId) as { hook_token: string };
    const response = await fetch(`${daemon.server.url}/hooks/${hook_token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', ...body }) });
    if (response.status >= 300) throw new Error(`world: hook ${String(body.hook_event_name)} answered ${response.status}`);
  };

  /** The process of the session dies on its own after printing something: a crash. */
  const crash = (sessionId: string) => {
    const fakeHarness = daemon.harnesses.find((harness) => harness instanceof FakeHarness) as FakeHarness;
    const launchIndex = fakeHarness.launches.map((launch) => launch.sessionId).lastIndexOf(sessionId);
    const handle = fakeHarness.handles[launchIndex]!;
    handle.emitData('working…');
    handle.emitExit(137);
  };

  const connect = async (sessionId: string) => {
    const { mcp_token } = daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string };
    const client = new Client({ name: 'trigger-world', version: '1' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${mcp_token}` } } }));
    return client;
  };

  /** A WebSocket client of the daemon; `framesOfType` lists what it received. */
  const openSocket = async () => {
    const { ticket } = await json<{ ticket: string }>(await api('/api/ws-ticket', { method: 'POST' }));
    const socket = new WebSocket(`${daemon.server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
    sockets.push(socket);
    const frames: { type: string; [key: string]: unknown }[] = [];
    socket.addEventListener('message', (message) => frames.push(JSON.parse(String(message.data))));
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
    return { framesOfType: (type: string) => frames.filter((frame) => frame.type === type) };
  };

  const stop = async () => {
    for (const socket of sockets.splice(0)) socket.close();
    for (const client of clients.splice(0)) await client.close();
    await daemon.close();
  };

  return {
    config,
    get daemon() { return daemon; },
    get db(): DatabaseSync { return daemon.db; },
    get engine() { return daemon.triggerEngine; },
    get nowMs() { return nowMs; },
    advanceMs: (ms: number) => { nowMs += ms; },
    api, json, createSession, createChild, postHook, crash, createArmedTrigger, connect, openSocket,
    livingTimers: () => timers.filter((timer) => !timer.isCancelled),
    fireLivingTimers: () => { for (const timer of timers.filter((candidate) => !candidate.isCancelled)) { timer.isCancelled = true; timer.callback(); } },
    /** The session as a daemon that stopped and started again finds it. */
    restart: async ({ stoppedForMs = 0, whileStopped = () => {} }: { stoppedForMs?: number; whileStopped?: (db: DatabaseSync) => void } = {}) => {
      await stop();
      whileStopped(daemon.db);
      daemon.db.close();
      nowMs += stoppedForMs;
      await boot();
    },
    messagesTo: (sessionId: string) => daemon.db.prepare('SELECT id, body FROM message_queue WHERE session_id = ? ORDER BY created_at, rowid').all(sessionId) as { id: string; body: string }[],
    firesOf: (triggerId: string) => daemon.db.prepare('SELECT id, dedup_key, ledger_state, settle_reason, fired_at FROM trigger_fires WHERE trigger_id = ? ORDER BY fired_at, rowid').all(triggerId) as unknown as FireRow[],
    close: async () => { await stop(); daemon.db.close(); directories.removeAll(); },
    managerSpec: MANAGER_SPEC,
  };
}

export type TriggerWorld = Awaited<ReturnType<typeof startTriggerWorld>>;
