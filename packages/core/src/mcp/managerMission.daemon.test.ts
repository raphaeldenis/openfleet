import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '@openfleet/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const PROJECT_ID = randomUUID();
const THIRTY_KB = 30 * 1024;
const EIGHT_KB = 8 * 1024;
const SAFE_ANSWER_BYTES = 24 * 1024;
const STATUS_BUDGET_BYTES = 2 * 1024;

const tempDirs = createTempDirTracker();
const openClients: Client[] = [];

let config: Config;
let daemon: Daemon;

type Json = Record<string, unknown>;

const textOf = (result: unknown): string => (result as { content: { text: string }[] }).content[0]!.text;
const jsonOf = (result: unknown): Json => JSON.parse(textOf(result)) as Json;
const sizeInBytes = (text: string) => Buffer.byteLength(text, 'utf8');
const sha256Of = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const missionOfBytes = (bytes: number) => `START-OF-MISSION\n${'m'.repeat(bytes - 'START-OF-MISSION\n'.length)}`;

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...(init.headers ?? {}) } });
const aManagerWithMission = async (name: string, mission: string, { withoutProject = false }: { withoutProject?: boolean } = {}) => {
  const projectField = withoutProject ? {} : { projectId: PROJECT_ID };
  const created = (await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: config.worktreesRoot, harness: 'fake', emoji: '🧭', name, ...projectField, manager: { pulseSeconds: 3600, childrenCap: 5, mission: 'placeholder' } }) })).json()) as { id: string };
  daemon.db.prepare('UPDATE managers SET mission_text = ? WHERE session_id = ?').run(mission, created.id);
  return created.id;
};
const aPlainSession = async (name: string) =>
  ((await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: config.worktreesRoot, harness: 'fake', emoji: '🔧', name, projectId: PROJECT_ID }) })).json()) as { id: string }).id;
const aNoteIn = async (projectId: string, title: string, bodyMd: string) => {
  const created = (await (await api('/api/notes', { method: 'POST', body: JSON.stringify({ projectId, title, bodyMd }) })).json()) as { id: string };
  return created.id;
};
const aNoteBody = (title: string, bodyMd: string) => aNoteIn(PROJECT_ID, title, bodyMd);
const mcpClientOf = async (sessionId: string): Promise<Client> => {
  const { mcp_token } = daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string };
  const client = new Client({ name: 'manager-mission', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcp_token}` } } }));
  openClients.push(client);
  return client;
};
const callTool = (client: Client, name: string, args: Json = {}) => client.callTool({ name, arguments: args });

beforeAll(async () => {
  config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-manager-mission-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  mkdirSync(config.worktreesRoot, { recursive: true });
  const seedDb = openDatabase(config.dbPath);
  new ProjectRepository(seedDb).insert({ id: PROJECT_ID, name: 'Fleet', docsFolderPath: null, createdAt: 't0' });
  seedDb.close();
  daemon = await startDaemon(config);
});
afterAll(async () => {
  await Promise.all(openClients.map((client) => client.close()));
  await daemon.close();
  tempDirs.removeAll();
});

describe('get_argus_status never carries the body of the mission', () => {
  it('adds no more than a digest of the mission: a manager with a 30 KB mission, no child and no scheduled event gets an answer under 2 KB', async () => {
    const mission = missionOfBytes(THIRTY_KB);
    const client = await mcpClientOf(await aManagerWithMission('Heavy', mission));

    const status = await callTool(client, 'get_argus_status');

    expect(sizeInBytes(textOf(status))).toBeLessThan(STATUS_BUDGET_BYTES);
    expect(textOf(status)).not.toContain('START-OF-MISSION');
  });

  it('gives the size in bytes and the sha256 of the mission in place of its text', async () => {
    const mission = missionOfBytes(THIRTY_KB);
    const client = await mcpClientOf(await aManagerWithMission('Measured', mission));

    const { manager } = jsonOf(await callTool(client, 'get_argus_status')) as { manager: Json };

    expect(manager).not.toHaveProperty('missionText');
    expect(manager).toMatchObject({ missionBytes: THIRTY_KB, missionSha256: sha256Of(mission) });
  });

  it('counts the bytes of a mission in UTF-8, not in characters', async () => {
    const mission = 'é'.repeat(100);
    const client = await mcpClientOf(await aManagerWithMission('Accented', mission));

    const { manager } = jsonOf(await callTool(client, 'get_argus_status')) as { manager: Json };

    expect(manager).toMatchObject({ missionBytes: 200, missionSha256: sha256Of(mission) });
  });
});

describe('get_manager_mission', () => {
  it('returns the whole mission of the calling manager with its size and sha256', async () => {
    const mission = missionOfBytes(EIGHT_KB);
    const client = await mcpClientOf(await aManagerWithMission('Reader', mission));

    const answer = jsonOf(await callTool(client, 'get_manager_mission'));

    expect(answer).toMatchObject({ missionText: mission, missionBytes: EIGHT_KB, missionSha256: sha256Of(mission) });
    expect(answer).not.toHaveProperty('complete');
    expect(answer).not.toHaveProperty('mentionsIndex');
  });

  it('keeps every answer under the 24 KiB a get_note answer keeps, and pages a mission whose own text is larger', async () => {
    const mission = missionOfBytes(THIRTY_KB);
    const client = await mcpClientOf(await aManagerWithMission('Paged', mission));

    const firstPage = jsonOf(await callTool(client, 'get_manager_mission'));

    expect(sizeInBytes(JSON.stringify(firstPage))).toBeLessThanOrEqual(SAFE_ANSWER_BYTES);
    expect(firstPage).toMatchObject({ truncated: true, complete: false, offset: 0, totalBytes: THIRTY_KB, missionBytes: THIRTY_KB, missionSha256: sha256Of(mission) });
    expect(firstPage.nextAction).toBe(`get_manager_mission offset=${firstPage.nextOffset}`);
  });

  it('gives back the whole mission when its pages are read one after the other', async () => {
    const mission = missionOfBytes(THIRTY_KB);
    const client = await mcpClientOf(await aManagerWithMission('Reassembled', mission));

    const pages: Json[] = [];
    let nextOffset: number | undefined = 0;
    while (nextOffset !== undefined) {
      const page = jsonOf(await callTool(client, 'get_manager_mission', { offset: nextOffset }));
      pages.push(page);
      nextOffset = page.nextOffset as number | undefined;
    }

    expect(pages.length).toBeGreaterThan(1);
    const reassembled = pages.map((page) => page.missionText).join('');
    expect(sha256Of(reassembled)).toBe(sha256Of(mission));
    expect(reassembled).toBe(mission);
  });

  it('answers under 24 KiB with an index of the mentions it does not expand when the mission and the notes it mentions together exceed it', async () => {
    const bigNoteBody = `START-OF-BIG-NOTE\n${'n'.repeat(THIRTY_KB)}`;
    const bigNoteId = await aNoteBody('Big', bigNoteBody);
    const mission = `${missionOfBytes(EIGHT_KB)}\nFollow @note:${bigNoteId}`;
    const client = await mcpClientOf(await aManagerWithMission('Overflowing', mission));

    const answer = jsonOf(await callTool(client, 'get_manager_mission'));

    expect(sizeInBytes(JSON.stringify(answer))).toBeLessThan(SAFE_ANSWER_BYTES);
    expect(answer).toMatchObject({ missionText: mission, complete: false, missionBytes: sizeInBytes(mission), missionSha256: sha256Of(mission) });
    expect(answer.mentionsIndex).toEqual([{ id: bigNoteId, type: 'note', bytes: sizeInBytes(bigNoteBody), readWith: `get_note note=${bigNoteId}` }]);
    expect(textOf(await callTool(client, 'get_manager_mission'))).not.toContain('START-OF-BIG-NOTE');
  });

  it('lets the manager find the whole content of a mention it was not given by reading it with get_note', async () => {
    const bigNoteBody = `START-OF-BIG-NOTE\n${'n'.repeat(THIRTY_KB)}`;
    const bigNoteId = await aNoteBody('Big again', bigNoteBody);
    const client = await mcpClientOf(await aManagerWithMission('Rereading', `${missionOfBytes(EIGHT_KB)}\nFollow @note:${bigNoteId}`));
    const { mentionsIndex } = jsonOf(await callTool(client, 'get_manager_mission')) as { mentionsIndex: { id: string }[] };

    let reread = '';
    let nextOffset: number | undefined = 0;
    while (nextOffset !== undefined) {
      const page = jsonOf(await callTool(client, 'get_note', { note: mentionsIndex[0]!.id, offset: nextOffset }));
      reread += page.bodyMd as string;
      nextOffset = page.nextOffset as number | undefined;
    }

    expect(reread).toBe(bigNoteBody);
  });

  it('does not expand the mission note into the mission that mentions it', async () => {
    const missionNoteId = await aNoteBody('Mission note', 'BODY-OF-THE-MISSION-NOTE');
    const managerId = await aManagerWithMission('Self-mentioning', `Mission written in @note:${missionNoteId}`);
    daemon.db.prepare('UPDATE managers SET mission_note_id = ? WHERE session_id = ?').run(missionNoteId, managerId);
    const client = await mcpClientOf(managerId);

    const { missionText } = jsonOf(await callTool(client, 'get_manager_mission')) as { missionText: string };

    expect(missionText).not.toContain('BODY-OF-THE-MISSION-NOTE');
    expect(missionText).toContain(`--- @note:${missionNoteId}: not expanded (mission note: read it with get_note note=${missionNoteId}) ---`);
    expect(missionText).not.toContain('already expanded');
  });

  it('lists the mission note in the index with the same get_note call when the mission is too large to expand its mentions', async () => {
    const missionNoteId = await aNoteBody('Mission note in index', 'BODY-OF-THE-MISSION-NOTE');
    const bigNoteId = await aNoteBody('Big beside the mission note', 'n'.repeat(THIRTY_KB));
    const managerId = await aManagerWithMission('Indexing', `${missionOfBytes(EIGHT_KB)}\n@note:${missionNoteId} @note:${bigNoteId}`);
    daemon.db.prepare('UPDATE managers SET mission_note_id = ? WHERE session_id = ?').run(missionNoteId, managerId);
    const client = await mcpClientOf(managerId);

    const { mentionsIndex } = jsonOf(await callTool(client, 'get_manager_mission')) as { mentionsIndex: { id: string; readWith: string }[] };

    expect(mentionsIndex.find((entry) => entry.id === missionNoteId)?.readWith).toBe(`get_note note=${missionNoteId}`);
  });

  it('lowers the cap with max_bytes', async () => {
    const client = await mcpClientOf(await aManagerWithMission('Lowered', missionOfBytes(EIGHT_KB)));

    const page = jsonOf(await callTool(client, 'get_manager_mission', { max_bytes: 4 * 1024 }));

    expect(sizeInBytes(JSON.stringify(page))).toBeLessThanOrEqual(4 * 1024);
    expect(page).toMatchObject({ truncated: true, complete: false });
  });

  it('keeps the floor of 2 KiB under a max_bytes below it', async () => {
    const client = await mcpClientOf(await aManagerWithMission('Floored', missionOfBytes(EIGHT_KB)));

    const page = jsonOf(await callTool(client, 'get_manager_mission', { max_bytes: 100 })) as { bytes: number };

    expect(sizeInBytes(JSON.stringify(page))).toBeLessThanOrEqual(2 * 1024);
    expect(page.bytes).toBeGreaterThan(1024);
  });

  it('never raises the cap above 24 KiB with max_bytes', async () => {
    const client = await mcpClientOf(await aManagerWithMission('Capped', missionOfBytes(THIRTY_KB)));

    const page = jsonOf(await callTool(client, 'get_manager_mission', { max_bytes: 10 * THIRTY_KB }));

    expect(sizeInBytes(JSON.stringify(page))).toBeLessThanOrEqual(SAFE_ANSWER_BYTES);
    expect(page).toMatchObject({ truncated: true });
  });

  it('gives an empty last page for an offset past the end of the mission, as get_note does', async () => {
    const client = await mcpClientOf(await aManagerWithMission('Past the end', missionOfBytes(THIRTY_KB)));

    const page = jsonOf(await callTool(client, 'get_manager_mission', { offset: 10 * THIRTY_KB }));

    expect(page).toMatchObject({ missionText: '', bytes: 0, truncated: false, complete: false });
    expect(page).not.toHaveProperty('nextOffset');
  });

  it('cuts a multi-byte mission between characters, never inside one', async () => {
    const mission = '€é'.repeat(3750);
    const client = await mcpClientOf(await aManagerWithMission('Multibyte', mission));

    const pages: Json[] = [];
    let nextOffset: number | undefined = 0;
    while (nextOffset !== undefined) {
      const page = jsonOf(await callTool(client, 'get_manager_mission', { offset: nextOffset, max_bytes: 2 * 1024 }));
      pages.push(page);
      nextOffset = page.nextOffset as number | undefined;
    }

    const texts = pages.map((page) => page.missionText as string);
    expect(pages.length).toBeGreaterThan(1);
    expect(texts.some((text) => text.includes('�'))).toBe(false);
    expect(texts.join('')).toBe(mission);
  });

  it('refuses the mission of another manager even when an offset is given', async () => {
    const otherManagerId = await aManagerWithMission('Other with offset', 'SECRET-MISSION-OF-ANOTHER');
    const client = await mcpClientOf(await aManagerWithMission('Curious with offset', 'Own mission'));

    const result = await callTool(client, 'get_manager_mission', { manager_id: otherManagerId, offset: 5 });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('error outside_lineage');
    expect(textOf(result)).not.toContain('SECRET-MISSION-OF-ANOTHER');
  });

  it('accepts the id of the calling manager itself', async () => {
    const managerId = await aManagerWithMission('Named', 'Ship the fleet');
    const client = await mcpClientOf(managerId);

    const answer = jsonOf(await callTool(client, 'get_manager_mission', { manager_id: managerId }));

    expect(answer).toMatchObject({ missionText: 'Ship the fleet' });
  });

  it('expands the @note mentions of the mission the way get_note does', async () => {
    const noteId = await aNoteBody('Plan', 'BODY-OF-THE-MENTIONED-NOTE');
    const client = await mcpClientOf(await aManagerWithMission('Mentioning', `Follow @note:${noteId}`));

    const { missionText, missionBytes } = jsonOf(await callTool(client, 'get_manager_mission')) as { missionText: string; missionBytes: number };

    expect(missionText).toContain(`Follow @note:${noteId}`);
    expect(missionText).toContain('--- from note @note:');
    expect(missionText).toContain('BODY-OF-THE-MENTIONED-NOTE');
    expect(missionBytes).toBe(sizeInBytes(`Follow @note:${noteId}`));
  });

  it('does not expand the mention of a note of another project that is not shared', async () => {
    const otherProjectId = randomUUID();
    new ProjectRepository(daemon.db).insert({ id: otherProjectId, name: 'Elsewhere', docsFolderPath: null, createdAt: 't0' });
    const privateNoteId = await aNoteIn(otherProjectId, 'Private', 'BODY-OF-A-PRIVATE-NOTE');
    const client = await mcpClientOf(await aManagerWithMission('Nosy', `See @note:${privateNoteId}`));

    const { missionText } = jsonOf(await callTool(client, 'get_manager_mission')) as { missionText: string };

    expect(missionText).not.toContain('BODY-OF-A-PRIVATE-NOTE');
    expect(missionText).toContain(`@note:${privateNoteId} → not resolved`);
  });

  it('returns the mission as stored when the manager has no project', async () => {
    const noteId = await aNoteBody('Plan', 'BODY-OF-A-NOTE-NOBODY-EXPANDS');
    const managerWithoutProjectId = await aManagerWithMission('Projectless', `Follow @note:${noteId}`, { withoutProject: true });
    const client = await mcpClientOf(managerWithoutProjectId);

    const { missionText } = jsonOf(await callTool(client, 'get_manager_mission')) as { missionText: string };

    expect(missionText).toBe(`Follow @note:${noteId}`);
  });

  it('refuses a session that is not a manager', async () => {
    const client = await mcpClientOf(await aPlainSession('Plain'));

    const result = await callTool(client, 'get_manager_mission');

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('error not_a_manager');
  });

  it('refuses the mission of another manager, even when the caller names it', async () => {
    const otherManagerId = await aManagerWithMission('Other', 'SECRET-MISSION-OF-ANOTHER');
    const client = await mcpClientOf(await aManagerWithMission('Curious', 'Own mission'));

    const result = await callTool(client, 'get_manager_mission', { manager_id: otherManagerId });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('error outside_lineage');
    expect(textOf(result)).not.toContain('SECRET-MISSION-OF-ANOTHER');
  });
});
