import { mkdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Session } from '@openfleet/shared';
import { loadConfig } from '../config.js';
import { startDaemon } from '../daemon.js';
import { childEnvironmentForGit } from '../process/childEnvironment.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import type { KnowledgeSearchResult } from '../knowledge/knowledgeTypes.js';
import type { DatabaseSync } from 'node:sqlite';
import { KnowledgeRepository } from '../knowledge/knowledgeRepository.js';
import { KnowledgeRepoScope } from '../knowledge/knowledgeRepoScope.js';
import { KnowledgeSearchService } from '../knowledge/knowledgeSearchService.js';

export function knowledgeSearchFor(db: DatabaseSync) {
  const repository = new KnowledgeRepository(db);
  const service = new KnowledgeSearchService({ search: repository, scope: new KnowledgeRepoScope({ repositories: repository }) });
  return { search: service.search.bind(service) };
}

export async function startKnowledgeFixture() {
  const directories = createTempDirTracker();
  const home = directories.make('knowledge-mcp-');
  const config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', OPENFLEET_E2E: '1' });
  const daemon = await startDaemon(config, { claudeConfigPath: join(home, 'harness-config.json'), power: { api: { acquire: () => ({ release: () => {} }) } } });
  const { db } = daemon;
  const clients: Client[] = [];
  const repositoryDirectory = join(home, 'repository');
  mkdirSync(repositoryDirectory);
  const root = realpathSync(repositoryDirectory);
  const gitOptions = { cwd: root, env: childEnvironmentForGit(process.env) };
  execFileSync('git', ['init', '-b', 'main'], gitOptions);
  execFileSync('git', ['-c', 'user.email=fixture@example.test', '-c', 'user.name=Fixture', 'commit', '--allow-empty', '-m', 'fixture'], gitOptions);
  db.exec("INSERT INTO projects (id, name, created_at) VALUES ('p', 'Fleet', 'now'), ('other', 'Other', 'now')");
  const register = db.prepare('INSERT INTO knowledge_repositories (project_id, repo_key, canonical_root, git_common_dir) VALUES (?, ?, ?, ?)');
  register.run('p', 'fleet', root, join(root, '.git'));
  register.run('p', 'second', '/second', '/second/.git');
  register.run('other', 'private', '/private', '/private/.git');
  register.run('other', 'fleet', '/foreign', '/foreign/.git');

  const api = (path: string, options: RequestInit = {}) => fetch(`${daemon.server.url}${path}`, {
    ...options, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...options.headers },
  });
  async function createSession(options: { projectId?: string | null; [key: string]: unknown } = {}) {
    const { projectId = 'p', ...sessionOptions } = options;
    const response = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: root, name: 'Reader', harness: 'fake', emoji: '🤖', ...sessionOptions }) });
    if (response.status !== 201) throw new Error(`fixture session: ${response.status} ${await response.text()}`);
    const session = await response.json() as Session;
    db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(projectId, session.id);
    return session;
  }
  const tokenOf = (id: string) => (db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(id) as { mcp_token: string }).mcp_token;
  async function connect(token: string) {
    const client = new Client({ name: 'knowledge-fixture', version: '1' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return client;
  }
  const manager = await createSession({ directory: home, manager: { childrenCap: 5, mission: 'Read curated facts', pulseSeconds: 3600 } });
  const managerClient = await connect(tokenOf(manager.id));
  const childDirectory = join(config.worktreesRoot, 'reader');
  mkdirSync(childDirectory);
  const spawned = await managerClient.callTool({ name: 'create_session', arguments: { directory: childDirectory, name: 'Child' } });
  const child = JSON.parse((spawned.content as { text: string }[])[0]!.text) as Session;
  if (!child.id) throw new Error(`fixture child: ${JSON.stringify(spawned)}`);
  db.prepare("UPDATE sessions SET project_id = 'p' WHERE id = ?").run(child.id);
  const childClient = await connect(tokenOf(child.id));
  function seed({ id = 'active', project = 'p', repo = 'fleet', fact = 'needle', area = 'architecture', provenance = null, retired = null }: { id?: string; project?: string; repo?: string; fact?: string; area?: string; provenance?: string | null; retired?: string | null } = {}) {
    db.prepare('INSERT INTO knowledge (id, project_id, repo_key, area, fact, source_task, source_kind, verified_by, created_at, retired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, project, repo, area, fact, provenance, provenance, provenance, '2026-10-07T00:00:00.000Z', retired);
  }
  async function call(input: Record<string, unknown> = { repo: 'fleet', query: 'needle' }, client = childClient) {
    const result = await client.callTool({ name: 'search_knowledge', arguments: input });
    const text = (result.content as { text: string }[])[0]!.text;
    return { text, isError: result.isError === true, json: result.isError ? undefined : JSON.parse(text) as KnowledgeSearchResult };
  }
  const snapshot = () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'knowledge%' OR name LIKE '%ledger%' OR name LIKE '%seal%') ORDER BY name").all() as { name: string }[];
    return JSON.stringify(tables.map(({ name }) => ({ name, rows: db.prepare(`SELECT * FROM "${name}"`).all().map(row => JSON.stringify(row)).sort() })));
  };
  return { daemon, db, root, home, manager, child, managerClient, childClient, api, connect, createSession, tokenOf, seed, call, snapshot,
    close: async () => { for (const client of clients) await client.close(); await daemon.close(); db.close(); directories.removeAll(); },
  };
}
