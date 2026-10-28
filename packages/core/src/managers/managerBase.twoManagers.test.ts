import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '@openfleet/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import type { BaseNotReadEnforcement } from './baseReadGuard.js';
import { loadManagerBase, parseManagerBase, type ManagerBase } from './managerBase.js';
import { PULSE_MESSAGE } from './pulseScheduler.js';

const SHA_PREFIX_LENGTH = 8;
const PULSE_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 50;
const RESTART_TEST_TIMEOUT_MS = 20_000;
const SUBMIT_KEY = '\r';
const HOOK_DELIVERY_TIMEOUT_MS = 5000;
const freePort = () => new Promise<number>((resolve) => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); }); });

const FIRST_MANAGER = { name: 'Atlas', childrenCap: 2, mission: 'Atlas mission: keep the catalogue release on track.' };
const SECOND_MANAGER = { name: 'Borealis', childrenCap: 3, mission: 'Borealis mission: keep the mobile release on track.' };

const tempDirs = createTempDirTracker();
const shippedBase = loadManagerBase();

const bumpedBaseOf = (base: ManagerBase): ManagerBase =>
  parseManagerBase(`---\nversion: ${base.version + 1}\n---\n\n${base.body}\n\n## §99 Test addition [default]\n\nA line that only the bumped test base carries.\n`);
const bumpedBase = bumpedBaseOf(shippedBase);
const baseLineOf = (base: ManagerBase) => `Base v${base.version} (${base.sha.slice(0, SHA_PREFIX_LENGTH)})`;

/** No socket of the test stays pooled toward a daemon, so the resume hook of a restarted daemon on the same port never reuses a dead connection. */
const fetchClosingItsConnection: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set('connection', 'close');
  return fetch(input, { ...init, headers });
};

interface Spawn { refusedWith?: string; warningCodes: string[]; id?: string }
interface Manager { id: string; spec: typeof FIRST_MANAGER; client: Client }

class Fleet {
  readonly openClients: Client[] = [];
  daemon!: Daemon;
  managers: Manager[] = [];
  private childCounter = 0;

  constructor(readonly config: Config, private readonly enforcement: BaseNotReadEnforcement) {}

  async boot(managerBase?: ManagerBase) {
    this.daemon = await startDaemon(this.config, { baseNotReadEnforcement: this.enforcement, managerBase });
  }

  async shutDown() {
    await Promise.all(this.openClients.map((client) => client.close()));
    this.openClients.length = 0;
    await this.daemon.close();
  }

  /** Boots the daemon again on the same home with a newer base; each manager keeps the base read it had, as if the base moved under a running fleet. */
  async restartOn(managerBase: ManagerBase) {
    const readsBeforeRestart = this.daemon.db.prepare('SELECT session_id, base_version_read, base_sha_read, base_read_at FROM managers').all() as Record<string, string | number | null>[];
    await this.shutDown();
    await this.boot(managerBase);
    this.managers = await Promise.all(this.managers.map(async (manager) => ({ ...manager, client: await this.mcpClientOf(manager.id) })));
    for (const manager of this.managers) await this.startContextOf(manager);
    const restoreRead = this.daemon.db.prepare('UPDATE managers SET base_version_read = @base_version_read, base_sha_read = @base_sha_read, base_read_at = @base_read_at WHERE session_id = @session_id');
    for (const read of readsBeforeRestart) restoreRead.run(read);
  }

  api(path: string, init: RequestInit = {}) {
    return fetchClosingItsConnection(`${this.daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.adminToken}`, ...(init.headers ?? {}) } });
  }

  async mcpClientOf(sessionId: string): Promise<Client> {
    const { mcp_token } = this.daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string };
    const client = new Client({ name: 'two-managers', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${this.daemon.server.url}/mcp`), { fetch: fetchClosingItsConnection, requestInit: { headers: { Authorization: `Bearer ${mcp_token}` } } }));
    this.openClients.push(client);
    return client;
  }

  private async aProjectRoot(projectName: string): Promise<string> {
    const project = (await (await this.api('/api/projects', { method: 'POST', body: JSON.stringify({ name: projectName }) })).json()) as { id: string };
    const root = (await (await this.api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', harness: 'fake', emoji: '🧭', name: `${projectName} root`, projectId: project.id }) })).json()) as { id: string };
    return root.id;
  }

  async createManagerInItsOwnProject(spec: typeof FIRST_MANAGER): Promise<Manager> {
    const rootClient = await this.mcpClientOf(await this.aProjectRoot(`${spec.name} project`));
    const directory = join(this.config.worktreesRoot, spec.name);
    mkdirSync(directory, { recursive: true });
    const created = await rootClient.callTool({ name: 'create_session', arguments: { directory, name: spec.name, manager: { pulse_seconds: 3600, children_cap: spec.childrenCap, mission: spec.mission } } });
    const { id } = JSON.parse(textOf(created)) as { id: string };
    const manager = { id, spec, client: await this.mcpClientOf(id) };
    await this.startContextOf(manager);
    return manager;
  }

  /** The fake harness cannot reach the daemon on port 0, so the session start that makes a manager ready for a pulse is posted by hand. */
  async startContextOf(manager: Manager) {
    await this.postHook(manager, { hook_event_name: 'SessionStart', source: 'startup' });
  }

  /** A pulse typed into a manager stays queued until its turn is seen starting and ending; a restart would otherwise replay it. */
  async finishTurnOf(manager: Manager) {
    await this.postHook(manager, { hook_event_name: 'UserPromptSubmit' });
    await this.postHook(manager, { hook_event_name: 'Stop' });
  }

  private async postHook(manager: Manager, event: Record<string, string>) {
    const { hook_token } = this.daemon.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(manager.id) as { hook_token: string };
    await fetchClosingItsConnection(`${this.daemon.server.url}/hooks/${hook_token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', ...event }) });
  }

  /** Boots the daemon again on the same home and port, so the fake harness delivers its own resume hook; nothing is posted by hand. */
  async restartLettingTheHarnessResume() {
    await this.shutDown();
    await this.boot();
    this.managers = await Promise.all(this.managers.map(async (manager) => ({ ...manager, client: await this.mcpClientOf(manager.id) })));
  }

  baseShaReadBy(manager: Manager): string | null {
    return (this.daemon.db.prepare('SELECT base_sha_read FROM managers WHERE session_id = ?').get(manager.id) as { base_sha_read: string | null }).base_sha_read;
  }

  async spawnChildOf(manager: Manager): Promise<Spawn> {
    this.childCounter += 1;
    const name = `${manager.spec.name}-child-${this.childCounter}`;
    const directory = join(this.config.worktreesRoot, name);
    mkdirSync(directory, { recursive: true });
    const result = await manager.client.callTool({ name: 'create_session', arguments: { directory, name } });
    const text = textOf(result);
    if (result.isError) return { refusedWith: text, warningCodes: [] };
    const answer = JSON.parse(text) as { id: string; warnings?: { code: string }[] };
    return { id: answer.id, refusedWith: undefined, warningCodes: (answer.warnings ?? []).map((warning) => warning.code) };
  }

  readWholeBase(manager: Manager) {
    return manager.client.callTool({ name: 'get_manager_base', arguments: {} });
  }

  async closeAllChildrenOf(manager: Manager) {
    const children = this.daemon.db.prepare("SELECT id FROM sessions WHERE parent_id = ? AND state <> 'closed'").all(manager.id) as { id: string }[];
    for (const child of children) await manager.client.callTool({ name: 'close_session', arguments: { session_id: child.id } });
  }

  async resetContextOf(manager: Manager) {
    const { hook_token } = this.daemon.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(manager.id) as { hook_token: string };
    await fetchClosingItsConnection(`${this.daemon.server.url}/hooks/${hook_token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', hook_event_name: 'SessionStart', source: 'compact' }) });
  }

  missionTextOf(manager: Manager): string {
    return (this.daemon.db.prepare('SELECT mission_text FROM managers WHERE session_id = ?').get(manager.id) as { mission_text: string }).mission_text;
  }

  async pulseBothManagers(): Promise<string[]> {
    const harness = this.daemon.harnesses.find((candidate): candidate is FakeHarness => candidate instanceof FakeHarness)!;
    const entriesWritten = () => harness.handles.flatMap((handle) => handle.written);
    const pulseLinesWritten = () => entriesWritten().filter((entry) => entry.startsWith(PULSE_MESSAGE));
    const submissionsWritten = () => entriesWritten().filter((entry) => entry === SUBMIT_KEY);
    const alreadyWritten = pulseLinesWritten().length;
    const alreadySubmitted = submissionsWritten().length;
    for (const manager of this.managers) expect((await this.api(`/api/managers/${manager.id}/pulse`, { method: 'POST' })).status).toBe(200);
    await vi.waitFor(() => {
      expect(pulseLinesWritten().length - alreadyWritten).toBe(this.managers.length);
      expect(submissionsWritten().length - alreadySubmitted).toBe(this.managers.length);
    }, { timeout: PULSE_TIMEOUT_MS, interval: POLL_INTERVAL_MS });
    for (const manager of this.managers) await this.finishTurnOf(manager);
    return pulseLinesWritten().slice(alreadyWritten);
  }
}

const textOf = (result: unknown): string => (result as { content: { text: string }[] }).content[0]!.text;

describe('a daemon restart on the same base while no resume hook is delivered', () => {
  it('keeps the base read persisted for a manager: its next spawn is accepted without a warning', async () => {
    const config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-restart-same-base-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
    const fleet = new Fleet(config, 'refuse');
    await fleet.boot();
    const manager = await fleet.createManagerInItsOwnProject(FIRST_MANAGER);
    await fleet.readWholeBase(manager);
    await fleet.shutDown();
    await fleet.boot();
    const restartedManager = { ...manager, client: await fleet.mcpClientOf(manager.id) };

    const spawn = await fleet.spawnChildOf(restartedManager);

    expect(spawn).toMatchObject({ refusedWith: undefined, warningCodes: [] });
    await fleet.shutDown();
  }, RESTART_TEST_TIMEOUT_MS);
});

describe('a daemon restart on the same base, the fake harness delivering its resume hook (real path, refusing)', () => {
  let fleet: Fleet;
  let manager: Manager;

  const aRealPortConfig = async () => loadConfig({ OPENFLEET_HOME: tempDirs.make('of-resume-path-'), OPENFLEET_PORT: String(await freePort()), [E2E_FLAG_ENV]: E2E_FLAG_ON });
  const waitUntilBaseReadIsForgotten = () => vi.waitFor(() => expect(fleet.baseShaReadBy(manager)).toBeNull(), { timeout: HOOK_DELIVERY_TIMEOUT_MS, interval: POLL_INTERVAL_MS });

  beforeAll(async () => {
    fleet = new Fleet(await aRealPortConfig(), 'refuse');
    await fleet.boot();
    manager = await fleet.createManagerInItsOwnProject(FIRST_MANAGER);
    fleet.managers = [manager];
    await fleet.readWholeBase(manager);
  });
  afterAll(async () => {
    await fleet.shutDown();
    tempDirs.removeAll();
  });

  it('drops the base read of the manager once the resume hook reaches the restarted daemon', async () => {
    expect(fleet.baseShaReadBy(manager)).toBe(shippedBase.sha);

    await fleet.restartLettingTheHarnessResume();
    manager = fleet.managers[0]!;

    await waitUntilBaseReadIsForgotten();
  }, RESTART_TEST_TIMEOUT_MS);

  it('refuses the first spawn of the manager with base_not_read, telling it to read the base without section and spawn again', async () => {
    const spawn = await fleet.spawnChildOf(manager);

    expect(spawn.refusedWith).toContain('base_not_read');
    expect(spawn.refusedWith).toContain('Call get_manager_base without section, then spawn again.');
  });

  it('accepts the same spawn once the manager read the whole base', async () => {
    await fleet.readWholeBase(manager);

    const spawn = await fleet.spawnChildOf(manager);

    expect(spawn).toMatchObject({ refusedWith: undefined, warningCodes: [] });
  });

  it('leaves a manager that is not restarted unaffected: its spawn is accepted without a warning', async () => {
    const untouchedFleet = new Fleet(await aRealPortConfig(), 'refuse');
    await untouchedFleet.boot();
    const untouchedManager = await untouchedFleet.createManagerInItsOwnProject(SECOND_MANAGER);
    await untouchedFleet.readWholeBase(untouchedManager);

    const spawn = await untouchedFleet.spawnChildOf(untouchedManager);

    expect(spawn).toMatchObject({ refusedWith: undefined, warningCodes: [] });
    expect(untouchedFleet.baseShaReadBy(untouchedManager)).toBe(shippedBase.sha);
    await untouchedFleet.shutDown();
  }, RESTART_TEST_TIMEOUT_MS);
});

describe.each<BaseNotReadEnforcement>(['refuse', 'warn_only'])('two managers of different projects follow one shared base (enforcement %s)', (enforcement) => {
  const isRefusing = enforcement === 'refuse';
  let fleet: Fleet;
  let first: Manager;
  let second: Manager;
  let missionsAtCreation: string[];

  beforeAll(async () => {
    const config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-two-managers-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
    fleet = new Fleet(config, enforcement);
    await fleet.boot();
    first = await fleet.createManagerInItsOwnProject(FIRST_MANAGER);
    second = await fleet.createManagerInItsOwnProject(SECOND_MANAGER);
    fleet.managers = [first, second];
    missionsAtCreation = fleet.managers.map((manager) => fleet.missionTextOf(manager));
  });
  afterAll(async () => {
    await fleet.shutDown();
    tempDirs.removeAll();
  });

  const refreshManagers = () => { [first, second] = fleet.managers as [Manager, Manager]; };

  it('keeps each manager under its own children cap, 2 and 3', async () => {
    await fleet.readWholeBase(first);
    await fleet.readWholeBase(second);

    const firstSpawns = [await fleet.spawnChildOf(first), await fleet.spawnChildOf(first), await fleet.spawnChildOf(first)];
    const secondSpawns = [await fleet.spawnChildOf(second), await fleet.spawnChildOf(second), await fleet.spawnChildOf(second), await fleet.spawnChildOf(second)];

    expect(firstSpawns.map((spawn) => spawn.refusedWith === undefined)).toEqual([true, true, false]);
    expect(firstSpawns[2]!.refusedWith).toContain('children_cap');
    expect(secondSpawns.map((spawn) => spawn.refusedWith === undefined)).toEqual([true, true, true, false]);
    expect(secondSpawns[3]!.refusedWith).toContain('children_cap');
  });

  it('carries the shipped base version and sha in the pulse of both managers', async () => {
    await fleet.closeAllChildrenOf(first);
    await fleet.closeAllChildrenOf(second);

    const pulses = await fleet.pulseBothManagers();

    expect(pulses.every((pulse) => pulse.includes(baseLineOf(shippedBase)))).toBe(true);
  });

  it('carries the bumped version and sha in the next pulse of both managers', async () => {
    await fleet.restartOn(bumpedBase);
    refreshManagers();

    const pulses = await fleet.pulseBothManagers();

    expect(pulses.every((pulse) => pulse.includes(baseLineOf(bumpedBase)))).toBe(true);
    expect(pulses.some((pulse) => pulse.includes(baseLineOf(shippedBase)))).toBe(false);
  }, RESTART_TEST_TIMEOUT_MS);

  it(isRefusing ? 'refuses both spawns until the bumped base is read whole' : 'warns both spawns, never refuses, until the bumped base is read whole', async () => {
    const firstSpawn = await fleet.spawnChildOf(first);
    const secondSpawn = await fleet.spawnChildOf(second);

    if (isRefusing) {
      expect(firstSpawn.refusedWith).toContain('base_not_read');
      expect(secondSpawn.refusedWith).toContain('base_not_read');
    } else {
      expect(firstSpawn).toMatchObject({ refusedWith: undefined, warningCodes: ['base_not_read'] });
      expect(secondSpawn).toMatchObject({ refusedWith: undefined, warningCodes: ['base_not_read'] });
    }
  });

  it('accepts the manager that read the bumped base whole, while the other one still has not read it', async () => {
    await fleet.closeAllChildrenOf(first);
    await fleet.closeAllChildrenOf(second);
    await fleet.readWholeBase(first);

    const readerSpawn = await fleet.spawnChildOf(first);
    const nonReaderSpawn = await fleet.spawnChildOf(second);

    expect(readerSpawn).toMatchObject({ refusedWith: undefined, warningCodes: [] });
    if (isRefusing) expect(nonReaderSpawn.refusedWith).toContain('base_not_read');
    else expect(nonReaderSpawn).toMatchObject({ refusedWith: undefined, warningCodes: ['base_not_read'] });
  });

  it('accepts both spawns without a warning once each manager read the bumped base whole', async () => {
    await fleet.closeAllChildrenOf(first);
    await fleet.closeAllChildrenOf(second);
    await fleet.readWholeBase(second);

    const firstSpawn = await fleet.spawnChildOf(first);
    const secondSpawn = await fleet.spawnChildOf(second);

    expect(firstSpawn).toMatchObject({ refusedWith: undefined, warningCodes: [] });
    expect(secondSpawn).toMatchObject({ refusedWith: undefined, warningCodes: [] });
  });

  it(isRefusing ? 'refuses only the manager whose context was reset' : 'warns only the manager whose context was reset, and never refuses', async () => {
    await fleet.resetContextOf(first);

    const resetSpawn = await fleet.spawnChildOf(first);
    const untouchedSpawn = await fleet.spawnChildOf(second);

    if (isRefusing) expect(resetSpawn.refusedWith).toContain('base_not_read');
    else expect(resetSpawn).toMatchObject({ refusedWith: undefined, warningCodes: ['base_not_read'] });
    expect(untouchedSpawn).toMatchObject({ refusedWith: undefined, warningCodes: [] });
  });

  it('leaves both mission texts byte for byte as created, with no copy of the base in them', () => {
    const missionsNow = fleet.managers.map((manager) => fleet.missionTextOf(manager));

    expect(missionsNow).toEqual(missionsAtCreation);
    expect(missionsNow).toEqual([FIRST_MANAGER.mission, SECOND_MANAGER.mission]);
    expect(missionsNow.some((mission) => mission.includes(shippedBase.sha) || mission.includes(bumpedBase.sha) || mission.includes('Precedence'))).toBe(false);
  });
});
