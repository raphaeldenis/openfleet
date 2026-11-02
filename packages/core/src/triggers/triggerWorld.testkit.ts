import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Session } from '@openfleet/shared';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { createTempDirTracker } from '../tempDirTracker.js';

export const PROJECT_ID = 'project-triggers';
export const MINUTE_MS = 60_000;
export const START_OF_WORLD = Date.parse('2026-11-02T10:00:00.000Z');
const MANAGER_SPEC = { childrenCap: 2, mission: 'Lead the fleet', pulseSeconds: 3600 };

export interface TriggerRecordView { id: string; contentRev: number; armedAt: string | null }
export interface FireRow { id: string; dedup_key: string; ledger_state: string; settle_reason: string | null; fired_at: string }

/** A real daemon on a throwaway home, with a fake clock, that can be stopped and started again on the same home the way a crash and a reboot do. */
export async function startTriggerWorld() {
  const directories = createTempDirTracker();
  const config: Config = loadConfig({ OPENFLEET_HOME: directories.make('trigger-world-'), OPENFLEET_PORT: '0', OPENFLEET_E2E: '1' });
  const clients: Client[] = [];
  let nowMs = START_OF_WORLD;
  let daemon!: Daemon;

  const boot = async () => {
    daemon = await startDaemon(config, {
      claudeConfigPath: join(config.home, 'harness-config.json'),
      power: { api: { acquire: () => ({ release: () => {} }) } },
      humanProof: { consume: () => true },
      triggers: { clock: () => nowMs },
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

  const connect = async (sessionId: string) => {
    const { mcp_token } = daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string };
    const client = new Client({ name: 'trigger-world', version: '1' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${mcp_token}` } } }));
    return client;
  };

  const stop = async () => {
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
    api, json, createSession, createArmedTrigger, connect,
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
