import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Session } from '@openfleet/shared';
import { loadConfig } from '../config.js';
import { startDaemon, type DaemonOptions } from '../daemon.js';
import { createTempDirTracker } from '../tempDirTracker.js';

export const OWN_PROJECT_ID = 'project-own';
export const OTHER_PROJECT_ID = 'project-other';

const MANAGER_SPEC = { childrenCap: 2, mission: 'Lead the fleet', pulseSeconds: 3600 };

/** A daemon booted the way production boots it (its own wiring, no hand-built services), with two managers and a plain session in one project. */
export async function startGovernanceFixture(options: Pick<DaemonOptions, 'gh'> = {}) {
  const directories = createTempDirTracker();
  const home = directories.make('governance-queue-');
  const config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', OPENFLEET_E2E: '1' });
  const daemon = await startDaemon(config, { claudeConfigPath: join(home, 'harness-config.json'), power: { api: { acquire: () => ({ release: () => {} }) } }, ...options });
  const { db } = daemon;
  const clients: Client[] = [];
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, 'Own', 'now'), (?, 'Other', 'now')").run(OWN_PROJECT_ID, OTHER_PROJECT_ID);

  const api = (path: string, options: RequestInit = {}) => fetch(`${daemon.server.url}${path}`, {
    ...options, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...options.headers },
  });
  const createdJson = async <T>(response: Response): Promise<T> => {
    if (response.status !== 201) throw new Error(`fixture: ${response.status} ${await response.text()}`);
    return await response.json() as T;
  };
  async function createSession(name: string, extra: Record<string, unknown> = {}) {
    const directory = join(home, name);
    mkdirSync(directory);
    const session = await createdJson<Session>(await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory, name, harness: 'fake', emoji: '🤖', ...extra }) }));
    db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(OWN_PROJECT_ID, session.id);
    return session;
  }
  const createTable = async (projectId: string, displayName: string) =>
    (await createdJson<{ id: string }>(await api('/api/data-stores', { method: 'POST', body: JSON.stringify({ projectId, displayName }) }))).id;
  const createNote = async (projectId: string, title: string, bodyMd = '# note') =>
    (await createdJson<{ id: string }>(await api('/api/notes', { method: 'POST', body: JSON.stringify({ projectId, title, bodyMd }) }))).id;

  const tokenOf = (sessionId: string) => (db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;
  async function connect(sessionId: string) {
    const client = new Client({ name: 'governance-fixture', version: '1' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokenOf(sessionId)}` } } }));
    return client;
  }

  const lead = await createSession('Lead', { manager: MANAGER_SPEC });
  const siblingLead = await createSession('Sibling lead', { manager: MANAGER_SPEC });
  const worker = await createSession('Worker');

  return {
    daemon, db, lead, siblingLead, worker, governanceQueue: daemon.governanceQueue,
    api, connect, createTable, createNote,
    close: async () => { for (const client of clients) await client.close(); await daemon.close(); db.close(); directories.removeAll(); },
  };
}

export type GovernanceFixture = Awaited<ReturnType<typeof startGovernanceFixture>>;
