import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '@openfleet/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const tempDirs = createTempDirTracker();
const PROJECT_ID = 'p1';
const SECTION_NUMBERS = [1, 2, 3, 4, 5];
const FILE_BACKED_NOTE_TITLE = 'design';

let daemon: Daemon;
let config: Config;

afterEach(async () => { await daemon.close(); tempDirs.removeAll(); });

const sectionHeading = (number: number) => `Section ${number}`;
const agentContentOf = (number: number) => `written by the agent for section ${number}`;
const originalBody = SECTION_NUMBERS.map((number) => `## ${sectionHeading(number)}\noriginal ${number}`).join('\n\n');

const adminApi = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}` } });
const mcpTokenOf = (sessionId: string) => (daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string }).mcp_token;
const parsed = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
const errorTextOf = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;

async function connectAs(sessionId: string): Promise<Client> {
  const client = new Client({ name: 'stale-overwrite', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcpTokenOf(sessionId)}` } } }));
  return client;
}

async function bootDaemon(seedProject: (projects: ProjectRepository) => void): Promise<void> {
  config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-stale-84-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  const seedDb = openDatabase(config.dbPath);
  seedProject(new ProjectRepository(seedDb));
  seedDb.close();
  daemon = await startDaemon(config);
}

async function agentInProject(): Promise<Client> {
  const created = (await (await adminApi('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'Agent', harness: 'fake', emoji: '🤖' }) })).json()) as { id: string };
  daemon.db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(PROJECT_ID, created.id);
  return connectAs(created.id);
}

const bootPlainProject = () => bootDaemon((projects) => projects.insert({ id: PROJECT_ID, name: 'One', docsFolderPath: null, createdAt: 't0' }));

interface NoteOverRest { id: string; rev: number; bodyMd: string }

const readNote = async (noteId: string) => (await (await adminApi(`/api/notes/${noteId}?projectId=${PROJECT_ID}`)).json()) as NoteOverRest;
const patchNote = (noteId: string, payload: object) => adminApi(`/api/notes/${noteId}`, { method: 'PATCH', body: JSON.stringify({ projectId: PROJECT_ID, ...payload }) });
const restoreNote = (noteId: string, payload: object) => adminApi(`/api/notes/${noteId}/restore`, { method: 'POST', body: JSON.stringify({ projectId: PROJECT_ID, ...payload }) });

async function createNoteWithFiveSections(): Promise<NoteOverRest> {
  const response = await adminApi('/api/notes', { method: 'POST', body: JSON.stringify({ projectId: PROJECT_ID, title: 'Mission', bodyMd: originalBody }) });
  return (await response.json()) as NoteOverRest;
}

/** The agent writes the five sections one after the other, each time with the revision it just received. */
async function agentWritesFiveSections(agent: Client, noteId: string, startRev: number): Promise<number> {
  let rev = startRev;
  for (const number of SECTION_NUMBERS) {
    const acknowledged = parsed(await agent.callTool({ name: 'update_note_section', arguments: { note: noteId, heading: sectionHeading(number), content: agentContentOf(number), expected_rev: rev } }));
    rev = acknowledged.rev;
  }
  return rev;
}

const expectEveryAgentSectionIn = (bodyMd: string) => {
  for (const number of SECTION_NUMBERS) expect(bodyMd).toContain(agentContentOf(number));
};

const versionRevsOf = async (agent: Client, noteId: string): Promise<number[]> =>
  parsed(await agent.callTool({ name: 'list_note_versions', arguments: { note: noteId } })).versions.map((version: { rev: number }) => version.rev);

describe('note #84 scenario: a stale client cannot silently erase what an agent wrote', () => {
  it('refuses a stale full-note PATCH with 409 stale_revision carrying the current rev, keeps every agent write, then accepts the reloaded save', async () => {
    await bootPlainProject();
    const agent = await agentInProject();
    const note = await createNoteWithFiveSections();
    const staleClientCopy = await readNote(note.id);
    const revAfterAgentWrites = await agentWritesFiveSections(agent, note.id, note.rev);

    const staleSave = await patchNote(note.id, { bodyMd: `${staleClientCopy.bodyMd}\n\nstale client edit`, expectedRev: staleClientCopy.rev });
    const refusal = (await staleSave.json()) as { error: string; currentRev: number; detail: { currentRev: number } };
    const afterRefusal = await readNote(note.id);

    expect(staleClientCopy.rev).toBe(1);
    expect(revAfterAgentWrites).toBe(6);
    expect(staleSave.status).toBe(409);
    expect(refusal.error).toBe('stale_revision');
    expect(refusal.currentRev).toBe(revAfterAgentWrites);
    expect(refusal.detail.currentRev).toBe(revAfterAgentWrites);
    expect(afterRefusal.rev).toBe(revAfterAgentWrites);
    expectEveryAgentSectionIn(afterRefusal.bodyMd);
    expect(afterRefusal.bodyMd).not.toContain('stale client edit');
    expect(await versionRevsOf(agent, note.id)).toHaveLength(6);

    const reloaded = await readNote(note.id);
    const reloadedSave = await patchNote(note.id, { bodyMd: `${reloaded.bodyMd}\n\nclient edit after reload`, expectedRev: reloaded.rev });
    const afterReloadedSave = await readNote(note.id);

    expect(reloadedSave.status).toBe(200);
    expect(afterReloadedSave.rev).toBe(revAfterAgentWrites + 1);
    expectEveryAgentSectionIn(afterReloadedSave.bodyMd);
    expect(afterReloadedSave.bodyMd).toContain('client edit after reload');
  });

  it('records one version per agent write, so each rev the stale client missed stays readable', async () => {
    await bootPlainProject();
    const agent = await agentInProject();
    const note = await createNoteWithFiveSections();

    await agentWritesFiveSections(agent, note.id, note.rev);

    expect(await versionRevsOf(agent, note.id)).toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 6]));
  });
});

describe('stale writes are refused on every other write path', () => {
  it('refuses a PATCH without expectedRev as invalid_body and leaves the note untouched', async () => {
    await bootPlainProject();
    const note = await createNoteWithFiveSections();

    const response = await patchNote(note.id, { bodyMd: 'overwrite without a revision' });
    const body = (await response.json()) as { error: string };
    const afterRefusal = await readNote(note.id);

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_body');
    expect(afterRefusal).toMatchObject({ rev: note.rev, bodyMd: originalBody });
  });

  it('refuses a REST restore without expectedRev as invalid_body', async () => {
    await bootPlainProject();
    const note = await createNoteWithFiveSections();

    const response = await restoreNote(note.id, { rev: 1 });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_body');
  });

  it('refuses a REST restore with a stale expectedRev with 409 stale_revision and keeps the agent writes', async () => {
    await bootPlainProject();
    const agent = await agentInProject();
    const note = await createNoteWithFiveSections();
    const revAfterAgentWrites = await agentWritesFiveSections(agent, note.id, note.rev);

    const response = await restoreNote(note.id, { rev: 1, expectedRev: 1 });
    const refusal = (await response.json()) as { error: string; currentRev: number };
    const afterRefusal = await readNote(note.id);

    expect(response.status).toBe(409);
    expect(refusal).toMatchObject({ error: 'stale_revision', currentRev: revAfterAgentWrites });
    expect(afterRefusal.rev).toBe(revAfterAgentWrites);
    expectEveryAgentSectionIn(afterRefusal.bodyMd);
  });

  it('refuses an MCP restore_note_version with a stale expected_rev and keeps the agent writes', async () => {
    await bootPlainProject();
    const agent = await agentInProject();
    const note = await createNoteWithFiveSections();
    const revAfterAgentWrites = await agentWritesFiveSections(agent, note.id, note.rev);

    const refused = await agent.callTool({ name: 'restore_note_version', arguments: { note: note.id, rev: 1, expected_rev: 1 } });
    const afterRefusal = await readNote(note.id);

    expect(refused.isError).toBe(true);
    expect(errorTextOf(refused)).toMatch(new RegExp(`^error stale_revision: .*current rev: ${revAfterAgentWrites}\\.`));
    expect(afterRefusal.rev).toBe(revAfterAgentWrites);
    expectEveryAgentSectionIn(afterRefusal.bodyMd);
  });

  it('refuses an MCP update_note_section with a stale expected_rev and keeps the earlier write', async () => {
    await bootPlainProject();
    const agent = await agentInProject();
    const note = await createNoteWithFiveSections();
    const first = parsed(await agent.callTool({ name: 'update_note_section', arguments: { note: note.id, heading: sectionHeading(1), content: agentContentOf(1), expected_rev: note.rev } }));

    const refused = await agent.callTool({ name: 'update_note_section', arguments: { note: note.id, heading: sectionHeading(2), content: 'late write', expected_rev: note.rev } });
    const afterRefusal = await readNote(note.id);

    expect(refused.isError).toBe(true);
    expect(errorTextOf(refused)).toMatch(new RegExp(`^error stale_revision: .*current rev: ${first.rev}\\.`));
    expect(afterRefusal.bodyMd).toContain(agentContentOf(1));
    expect(afterRefusal.bodyMd).not.toContain('late write');
  });

  it('documented gap, not covered: an MCP restore_note_version without expected_rev restores on top of the current revision and replaces the agent writes with the old body (still recoverable from history)', async () => {
    await bootPlainProject();
    const agent = await agentInProject();
    const note = await createNoteWithFiveSections();
    const revAfterAgentWrites = await agentWritesFiveSections(agent, note.id, note.rev);

    const restored = await agent.callTool({ name: 'restore_note_version', arguments: { note: note.id, rev: 1 } });
    const afterRestore = await readNote(note.id);

    expect(restored.isError).toBeFalsy();
    expect(afterRestore.rev).toBe(revAfterAgentWrites + 1);
    expect(afterRestore.bodyMd).toBe(originalBody);
    const lastAgentVersion = parsed(await agent.callTool({ name: 'get_note_version', arguments: { note: note.id, rev: revAfterAgentWrites } }));
    expectEveryAgentSectionIn(lastAgentVersion.bodyMd);
  });

  it('keeps both appends when two agents append at the same time', async () => {
    await bootPlainProject();
    const firstAgent = await agentInProject();
    const secondAgent = await agentInProject();
    const note = await createNoteWithFiveSections();

    await Promise.all([
      firstAgent.callTool({ name: 'append_to_note', arguments: { note: note.id, content: 'APPEND-ALPHA' } }),
      secondAgent.callTool({ name: 'append_to_note', arguments: { note: note.id, content: 'APPEND-BETA' } }),
    ]);
    const afterAppends = await readNote(note.id);

    expect(afterAppends.bodyMd).toContain('APPEND-ALPHA');
    expect(afterAppends.bodyMd).toContain('APPEND-BETA');
    expect(afterAppends.rev).toBe(note.rev + 2);
  });
});

describe('a file-backed note refuses a stale PATCH like any other note', () => {
  it('refuses a stale PATCH with 409 stale_revision and keeps the agent write on the note and on disk', async () => {
    const docsFolder = tempDirs.make('of-stale-84-docs-');
    mkdirSync(join(docsFolder, 'specs'));
    const noteFile = join(docsFolder, 'specs', `${FILE_BACKED_NOTE_TITLE}.md`);
    writeFileSync(noteFile, originalBody);
    await bootDaemon((projects) => projects.insert({ id: PROJECT_ID, name: 'One', docsFolderPath: docsFolder, createdAt: 't0' }));
    const agent = await agentInProject();
    const noteId = (daemon.db.prepare('SELECT id FROM notes WHERE title = ?').get(FILE_BACKED_NOTE_TITLE) as { id: string }).id;
    const staleClientCopy = await readNote(noteId);
    const written = parsed(await agent.callTool({ name: 'update_note_section', arguments: { note: noteId, heading: sectionHeading(1), content: agentContentOf(1), expected_rev: staleClientCopy.rev } }));

    const staleSave = await patchNote(noteId, { bodyMd: `${staleClientCopy.bodyMd}\n\nstale client edit`, expectedRev: staleClientCopy.rev });
    const refusal = (await staleSave.json()) as { error: string; currentRev: number };
    const afterRefusal = await readNote(noteId);

    expect(staleSave.status).toBe(409);
    expect(refusal).toMatchObject({ error: 'stale_revision', currentRev: written.rev });
    expect(afterRefusal.bodyMd).toContain(agentContentOf(1));
    expect(afterRefusal.bodyMd).not.toContain('stale client edit');
    const fileOnDisk = readFileSync(noteFile, 'utf8');
    expect(fileOnDisk).toContain(agentContentOf(1));
    expect(fileOnDisk).not.toContain('stale client edit');
  });
});
