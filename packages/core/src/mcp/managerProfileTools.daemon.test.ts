import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const PROJECT_ID = randomUUID();
const TOOL = 'set_manager_profile';
const SEVERAL_LIMIT_ACTIONS = Array.from({ length: 12 }, (_, index) => `Action ${index}`);

type Json = Record<string, unknown>;
type ManagerProfileView = { expertise?: string; pulseActions?: string[]; profileRev: number; missionText: string; missionNoteId?: string; baseRead?: unknown };

const directories = createTempDirTracker();
let daemon: Daemon;
let config: Config;
let clients: Client[];
let sockets: WebSocket[];
let spawnCount: number;

const api = (path: string, init: RequestInit = {}) => fetch(`${daemon.server.url}${path}`, {
  ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...init.headers },
});
const textOf = (result: unknown): string => (result as { content: { text: string }[] }).content[0]!.text;
const tokenOf = (sessionId: string) => (daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;
const profileOf = async (managerId: string): Promise<ManagerProfileView> => (await (await api(`/api/managers/${managerId}`)).json()).manager;
const patchProfile = (managerId: string, body: Json) => api(`/api/managers/${managerId}`, { method: 'PATCH', body: JSON.stringify(body) });

async function connect(sessionId: string): Promise<Client> {
  const client = new Client({ name: 'manager-profile-tool', version: '0.0.0' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokenOf(sessionId)}` } } }));
  return client;
}

/** What the caller reads back, whether the daemon answers with an error result or the protocol rejects the call. */
async function attempt(client: Client, args: Json): Promise<{ isRefused: boolean; text: string }> {
  try {
    const result = await client.callTool({ name: TOOL, arguments: args });
    return { isRefused: (result as { isError?: boolean }).isError === true, text: textOf(result) };
  } catch (error) {
    return { isRefused: true, text: String(error) };
  }
}

async function aRootSession(): Promise<string> {
  // The root works in the worktrees root, so every child directory made below it belongs to the project.
  const directory = config.worktreesRoot;
  const response = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory, name: 'Root', harness: 'fake', emoji: '🤖', projectId: PROJECT_ID }) });
  return (await response.json()).id;
}

async function spawn(parent: Client, extra: Json = {}): Promise<string> {
  const directory = join(config.worktreesRoot, `child-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const result = await parent.callTool({ name: 'create_session', arguments: { directory, name: `Spawned ${++spawnCount}`, ...extra } });
  return JSON.parse(textOf(result)).id;
}

interface Scene { managerA: string; managerB: string; a: Client; b: Client; childOfA: Client; reviewerOfA: Client }

async function aSceneWithTwoManagers(): Promise<Scene> {
  const root = await connect(await aRootSession());
  const spawnManager = () => spawn(root, { manager: { children_cap: 3, mission: 'Ship', pulse_seconds: 3600 } });
  const managerA = await spawnManager();
  const managerB = await spawnManager();
  const a = await connect(managerA);
  await a.callTool({ name: 'get_manager_base', arguments: {} });
  const childOfA = await connect(await spawn(a));
  const reviewerId = await spawn(a, { role: 'reviewer' });
  return { managerA, managerB, a, b: await connect(managerB), childOfA, reviewerOfA: await connect(reviewerId) };
}

beforeEach(async () => {
  clients = [];
  sockets = [];
  spawnCount = 0;
  const home = directories.make('of-profile-tool-');
  config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  mkdirSync(config.worktreesRoot, { recursive: true });
  const seedDb = openDatabase(config.dbPath);
  new ProjectRepository(seedDb).insert({ id: PROJECT_ID, name: 'Fleet', docsFolderPath: null, createdAt: 't0' });
  seedDb.close();
  daemon = await startDaemon(config, { claudeConfigPath: join(home, 'harness-config.json'), power: { api: { acquire: () => ({ release: () => {} }) } } });
});

afterEach(async () => {
  sockets.forEach((socket) => socket.close());
  await Promise.all(clients.map((client) => client.close()));
  await daemon?.close();
  directories.removeAll();
});

describe('set_manager_profile', () => {
  it('is offered next to the other manager tools, which stay offered', async () => {
    const { a } = await aSceneWithTwoManagers();

    const toolNames = (await a.listTools()).tools.map((tool) => tool.name);

    expect(toolNames).toEqual(expect.arrayContaining([TOOL, 'set_argus_log_store', 'get_argus_status', 'pulse_now']));
  });

  it('replaces the expertise and the pulse actions of the calling manager and answers with the profile only', async () => {
    const { a, managerA } = await aSceneWithTwoManagers();

    const result = await a.callTool({ name: TOOL, arguments: { expertise: 'Release safety', pulse_actions: ['Read CI', 'Triage the inbox'] } });

    expect(JSON.parse(textOf(result))).toEqual({ expertise: 'Release safety', pulseActions: ['Read CI', 'Triage the inbox'], profileRev: 2 });
    expect(await profileOf(managerA)).toMatchObject({ expertise: 'Release safety', pulseActions: ['Read CI', 'Triage the inbox'], profileRev: 2 });
  });

  it('leaves the other manager alone', async () => {
    const { a, managerB } = await aSceneWithTwoManagers();
    const before = await profileOf(managerB);

    await a.callTool({ name: TOOL, arguments: { expertise: 'Mine' } });

    expect(await profileOf(managerB)).toEqual(before);
  });

  it('keeps the fields it is not given', async () => {
    const { a, managerA } = await aSceneWithTwoManagers();
    await a.callTool({ name: TOOL, arguments: { expertise: 'Kept', pulse_actions: ['Keep me'] } });

    await a.callTool({ name: TOOL, arguments: { expertise: 'Changed' } });
    expect(await profileOf(managerA)).toMatchObject({ expertise: 'Changed', pulseActions: ['Keep me'] });

    await a.callTool({ name: TOOL, arguments: { pulse_actions: ['Replaced'] } });
    expect(await profileOf(managerA)).toMatchObject({ expertise: 'Changed', pulseActions: ['Replaced'] });
  });

  it('clears the fields given empty', async () => {
    const { a, managerA } = await aSceneWithTwoManagers();
    await a.callTool({ name: TOOL, arguments: { expertise: 'Soon gone', pulse_actions: ['Soon gone'] } });

    const result = await a.callTool({ name: TOOL, arguments: { expertise: '', pulse_actions: [] } });

    expect(JSON.parse(textOf(result))).toEqual({ expertise: '', pulseActions: [], profileRev: 3 });
    expect(await profileOf(managerA)).toMatchObject({ expertise: '', pulseActions: [] });
  });

  it('trims the text and counts characters, not bytes', async () => {
    const { a, managerA } = await aSceneWithTwoManagers();
    const fiveHundredChars = 'é船'.repeat(250);

    const result = await a.callTool({ name: TOOL, arguments: { expertise: `  ${fiveHundredChars}  `, pulse_actions: ['  Vérifier 船  '] } });

    expect(result.isError).not.toBe(true);
    expect(await profileOf(managerA)).toMatchObject({ expertise: fiveHundredChars, pulseActions: ['Vérifier 船'] });
  });

  describe('bounds', () => {
    it.each([
      { name: 'expertise of 500 characters', args: { expertise: 'x'.repeat(500) } },
      { name: '12 pulse actions', args: { pulse_actions: SEVERAL_LIMIT_ACTIONS } },
      { name: 'a pulse action of 280 characters', args: { pulse_actions: ['x'.repeat(280)] } },
    ])('accepts $name', async ({ args }) => {
      const { a } = await aSceneWithTwoManagers();

      const outcome = await attempt(a, args);

      expect(outcome.isRefused).toBe(false);
    });

    it.each([
      { name: 'expertise of 501 characters', args: { expertise: 'x'.repeat(501) } },
      { name: '13 pulse actions', args: { pulse_actions: [...SEVERAL_LIMIT_ACTIONS, 'one too many'] } },
      { name: 'a pulse action of 281 characters', args: { pulse_actions: ['x'.repeat(281)] } },
      { name: 'an exact duplicate', args: { pulse_actions: ['same', 'same'] } },
      { name: 'a duplicate once trimmed', args: { pulse_actions: [' same ', 'same'] } },
      { name: 'an empty pulse action', args: { pulse_actions: [''] } },
      { name: 'a blank pulse action', args: { pulse_actions: ['   '] } },
      { name: 'a null expertise', args: { expertise: null } },
      { name: 'pulse actions that are no list', args: { pulse_actions: 'not a list' } },
    ])('refuses $name and writes nothing', async ({ args }) => {
      const { a, managerA } = await aSceneWithTwoManagers();
      const before = await profileOf(managerA);

      const outcome = await attempt(a, { ...args, expertise: 'expertise' in args ? args.expertise : 'valid expertise' });

      expect(outcome.isRefused).toBe(true);
      expect(await profileOf(managerA)).toEqual(before);
    });

    it.each([
      { name: 'no field at all', args: {} },
      { name: 'only the expected revision', args: { expected_profile_rev: 1 } },
    ])('refuses $name and writes nothing', async ({ args }) => {
      const { a, managerA } = await aSceneWithTwoManagers();
      const before = await profileOf(managerA);

      const outcome = await attempt(a, args);

      expect(outcome.isRefused).toBe(true);
      expect(await profileOf(managerA)).toEqual(before);
    });
  });

  describe('who may call it', () => {
    it('refuses a plain child with not_a_manager and writes nothing to its parent', async () => {
      const { childOfA, managerA } = await aSceneWithTwoManagers();
      const before = await profileOf(managerA);

      const outcome = await attempt(childOfA, { expertise: 'Not mine' });

      expect(outcome.isRefused).toBe(true);
      expect(outcome.text).toContain('not_a_manager');
      expect(await profileOf(managerA)).toEqual(before);
    });

    it('refuses a reviewer and writes nothing to its manager', async () => {
      const { reviewerOfA, managerA } = await aSceneWithTwoManagers();
      const before = await profileOf(managerA);

      const outcome = await attempt(reviewerOfA, { expertise: 'Not mine' });

      expect(outcome.isRefused).toBe(true);
      expect(await profileOf(managerA)).toEqual(before);
    });

    it.each(['session_id', 'manager_id'])('refuses a %s input, so a manager cannot aim at another manager', async (targetField) => {
      const { a, managerA, managerB } = await aSceneWithTwoManagers();
      const [beforeA, beforeB] = [await profileOf(managerA), await profileOf(managerB)];

      const outcome = await attempt(a, { [targetField]: managerB, expertise: 'Hijack' });

      expect(outcome.isRefused).toBe(true);
      expect([await profileOf(managerA), await profileOf(managerB)]).toEqual([beforeA, beforeB]);
    });

    it('refuses any unknown field', async () => {
      const { a, managerA } = await aSceneWithTwoManagers();
      const before = await profileOf(managerA);

      const outcome = await attempt(a, { expertise: 'Unknown neighbour', childrenCap: 9 });

      expect(outcome.isRefused).toBe(true);
      expect(await profileOf(managerA)).toEqual(before);
    });

    it('refuses the mission atomically: nothing is written, the other fields given in the same call included', async () => {
      const { a, managerA } = await aSceneWithTwoManagers();
      const before = await profileOf(managerA);

      const outcome = await attempt(a, { mission: 'Rewritten by the agent', expertise: 'Should not land', pulse_actions: ['Should not land'] });

      expect(outcome.isRefused).toBe(true);
      expect(await profileOf(managerA)).toEqual(before);
    });
  });

  describe('expected_profile_rev', () => {
    it('writes when it is the current revision and moves the revision by one', async () => {
      const { a } = await aSceneWithTwoManagers();

      const result = await a.callTool({ name: TOOL, arguments: { expertise: 'Fresh', expected_profile_rev: 1 } });

      expect(JSON.parse(textOf(result))).toMatchObject({ expertise: 'Fresh', profileRev: 2 });
    });

    it('refuses a stale revision with stale_revision, writes nothing and tells the current revision in the text', async () => {
      const { a, managerA } = await aSceneWithTwoManagers();
      await patchProfile(managerA, { expertise: 'Human edit' });
      const before = await profileOf(managerA);

      const outcome = await attempt(a, { expertise: 'Stale write', pulse_actions: ['Stale write'], expected_profile_rev: 1 });

      expect(outcome.isRefused).toBe(true);
      expect(outcome.text).toContain('stale_revision');
      expect(outcome.text).toContain(`currentRev: ${before.profileRev}`);
      expect(await profileOf(managerA)).toEqual(before);
    });

    it('lets exactly one of a human REST write and an MCP write win when both expect the same revision', async () => {
      const { a, managerA } = await aSceneWithTwoManagers();

      const [rest, mcp] = await Promise.all([
        patchProfile(managerA, { expertise: 'From the human', expectedProfileRev: 1 }),
        attempt(a, { expertise: 'From the agent', expected_profile_rev: 1 }),
      ]);

      const outcomes = [rest.status === 200 ? 'success' : 'stale', mcp.isRefused ? 'stale' : 'success'].sort();
      expect(outcomes).toEqual(['stale', 'success']);
      const winner = rest.status === 200 ? 'From the human' : 'From the agent';
      expect(await profileOf(managerA)).toMatchObject({ expertise: winner, profileRev: 2 });
      if (mcp.isRefused) expect(mcp.text).toContain('stale_revision');
    });
  });

  describe('what it does not touch', () => {
    it('leaves the mission, the mission note and the base read unchanged', async () => {
      const { a, managerA } = await aSceneWithTwoManagers();
      const note = await (await api('/api/notes', { method: 'POST', body: JSON.stringify({ projectId: PROJECT_ID, title: 'Mission', bodyMd: '# Mission\n\n## Scope\n\noriginal' }) })).json();
      const missionNoteId: string = note.id ?? note.data.id;
      await patchProfile(managerA, { missionNoteId });
      await a.callTool({ name: 'get_manager_base', arguments: {} });
      const before = await profileOf(managerA);
      const noteBefore = daemon.db.prepare('SELECT body_md, rev FROM notes WHERE id = ?').get(missionNoteId);
      expect(before.baseRead).toBeDefined();

      await a.callTool({ name: TOOL, arguments: { expertise: 'Only the card', pulse_actions: ['Only the card'] } });

      const after = await profileOf(managerA);
      expect(after).toEqual({ ...before, expertise: 'Only the card', pulseActions: ['Only the card'], profileRev: before.profileRev + 1 });
      expect(daemon.db.prepare('SELECT body_md, rev FROM notes WHERE id = ?').get(missionNoteId)).toEqual(noteBefore);
    });

    it('never puts the mission in the answer', async () => {
      const { a } = await aSceneWithTwoManagers();

      const result = await a.callTool({ name: TOOL, arguments: { expertise: 'Card' } });

      expect(Object.keys(JSON.parse(textOf(result))).sort()).toEqual(['expertise', 'profileRev', 'pulseActions']);
    });
  });

  it('announces manager.updated once per write and not at all for a refused one', async () => {
    const { a, managerA } = await aSceneWithTwoManagers();
    const { ticket } = await (await api('/api/ws-ticket', { method: 'POST' })).json();
    const socket = new WebSocket(`${daemon.server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
    sockets.push(socket);
    const frames: { type: string; manager?: { sessionId: string; expertise?: string } }[] = [];
    socket.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data))));
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'snapshot')).toBe(true));
    const announcementsOf = (expertise: string) => frames.filter((frame) => frame.type === 'manager.updated' && frame.manager?.sessionId === managerA && frame.manager.expertise === expertise);

    await a.callTool({ name: TOOL, arguments: { expertise: 'Announced' } });
    await attempt(a, { expertise: 'Refused', expected_profile_rev: 1 });
    await a.callTool({ name: 'get_argus_status', arguments: {} });

    await vi.waitFor(() => expect(announcementsOf('Announced')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(announcementsOf('Announced')).toHaveLength(1);
    expect(announcementsOf('Refused')).toHaveLength(0);
  });
});
