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
import { recentLogLines } from '../logger.js';
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

  it('refuses an MCP update_note_section with a stale expected_rev when the same section changed since, and keeps the earlier write', async () => {
    await bootPlainProject();
    const agent = await agentInProject();
    const note = await createNoteWithFiveSections();
    const first = parsed(await agent.callTool({ name: 'update_note_section', arguments: { note: note.id, heading: sectionHeading(1), content: agentContentOf(1), expected_rev: note.rev } }));

    const refused = await agent.callTool({ name: 'update_note_section', arguments: { note: note.id, heading: sectionHeading(1), content: 'late write', expected_rev: note.rev } });
    const afterRefusal = await readNote(note.id);

    expect(refused.isError).toBe(true);
    expect(errorTextOf(refused)).toMatch(new RegExp(`^error stale_revision: .*current rev: ${first.rev}\\.`));
    expect(afterRefusal.bodyMd).toContain(agentContentOf(1));
    expect(afterRefusal.bodyMd).not.toContain('late write');
    expect(afterRefusal.rev).toBe(first.rev);
  });

  it('documented gap, not covered: an MCP restore_note_version without expected_rev still restores on top of the current revision, but the reply carries a warning that expected_rev becomes required, and the daemon logs it without the body', async () => {
    await bootPlainProject();
    const agent = await agentInProject();
    const note = await createNoteWithFiveSections();
    const revAfterAgentWrites = await agentWritesFiveSections(agent, note.id, note.rev);

    const restored = await agent.callTool({ name: 'restore_note_version', arguments: { note: note.id, rev: 1 } });
    const afterRestore = await readNote(note.id);
    const acknowledged = parsed(restored);
    const warnLines = recentLogLines().filter((line) => line.includes('restore without expected_rev'));

    expect(restored.isError).toBeFalsy();
    expect(acknowledged.warning).toMatch(/expected_rev will be required in the next release.*get_note/);
    expect(acknowledged.rev).toBe(revAfterAgentWrites + 1);
    expect(afterRestore.bodyMd).toBe(originalBody);
    expect(warnLines.length).toBeGreaterThan(0);
    expect(warnLines.at(-1)).toContain(note.id);
    expect(warnLines.at(-1)).not.toContain('original 1');
    const lastAgentVersion = parsed(await agent.callTool({ name: 'get_note_version', arguments: { note: note.id, rev: revAfterAgentWrites } }));
    expectEveryAgentSectionIn(lastAgentVersion.bodyMd);
  });

  it('does not warn when restore_note_version carries expected_rev', async () => {
    await bootPlainProject();
    const agent = await agentInProject();
    const note = await createNoteWithFiveSections();

    const restored = parsed(await agent.callTool({ name: 'restore_note_version', arguments: { note: note.id, rev: 1, expected_rev: note.rev } }));

    expect(restored.warning).toBeUndefined();
  });

  it('refuses an MCP restore_note_version that is exactly one revision behind: no tolerance with expected_rev, the current rev is reported', async () => {
    await bootPlainProject();
    const agent = await agentInProject();
    const note = await createNoteWithFiveSections();
    const revAfterAgentWrites = await agentWritesFiveSections(agent, note.id, note.rev);

    const refused = await agent.callTool({ name: 'restore_note_version', arguments: { note: note.id, rev: 1, expected_rev: revAfterAgentWrites - 1 } });
    const afterRefusal = await readNote(note.id);

    expect(refused.isError).toBe(true);
    expect(errorTextOf(refused)).toMatch(new RegExp(`^error stale_revision: .*current rev: ${revAfterAgentWrites}\\.`));
    expect(afterRefusal.rev).toBe(revAfterAgentWrites);
    expectEveryAgentSectionIn(afterRefusal.bodyMd);
  });

  it('restores a past revision when expected_rev is the current one, as a new forward revision that keeps the replaced body in history', async () => {
    await bootPlainProject();
    const agent = await agentInProject();
    const note = await createNoteWithFiveSections();
    const revAfterAgentWrites = await agentWritesFiveSections(agent, note.id, note.rev);

    const restored = parsed(await agent.callTool({ name: 'restore_note_version', arguments: { note: note.id, rev: 1, expected_rev: revAfterAgentWrites } }));
    const afterRestore = await readNote(note.id);

    expect(restored.rev).toBe(revAfterAgentWrites + 1);
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

const writeSection = (agent: Client, noteId: string, number: number, expectedRev: number, content = agentContentOf(number)) =>
  agent.callTool({ name: 'update_note_section', arguments: { note: noteId, heading: sectionHeading(number), content, expected_rev: expectedRev } });

describe('update_note_section merges disjoint sections of a stale write and refuses overlapping ones', () => {
  it('applies a stale write to the current revision when its section is unchanged since expected_rev, and says merged: true', async () => {
    await bootPlainProject();
    const firstAgent = await agentInProject();
    const secondAgent = await agentInProject();
    const note = await createNoteWithFiveSections();
    const firstWrite = parsed(await writeSection(firstAgent, note.id, 1, note.rev));

    const merged = parsed(await writeSection(secondAgent, note.id, 2, note.rev));
    const afterMerge = await readNote(note.id);

    expect(merged.merged).toBe(true);
    expect(merged.rev).toBe(firstWrite.rev + 1);
    expect(afterMerge.rev).toBe(merged.rev);
    expect(afterMerge.bodyMd).toContain(agentContentOf(1));
    expect(afterMerge.bodyMd).toContain(agentContentOf(2));
    expect(afterMerge.bodyMd).toContain('original 3');
    expect(await versionRevsOf(secondAgent, note.id)).toEqual([1, 2, 3]);
  });

  it('does not mark a write on the current revision as merged', async () => {
    await bootPlainProject();
    const agent = await agentInProject();
    const note = await createNoteWithFiveSections();

    const written = parsed(await writeSection(agent, note.id, 1, note.rev));

    expect(written.merged).toBeUndefined();
  });

  it('merges across several intermediate revisions that touched other sections', async () => {
    await bootPlainProject();
    const firstAgent = await agentInProject();
    const secondAgent = await agentInProject();
    const note = await createNoteWithFiveSections();
    let rev = note.rev;
    for (const number of [1, 2, 3]) rev = parsed(await writeSection(firstAgent, note.id, number, rev)).rev;

    const merged = parsed(await writeSection(secondAgent, note.id, 4, note.rev));
    const afterMerge = await readNote(note.id);

    expect(merged).toMatchObject({ merged: true, rev: rev + 1 });
    for (const number of [1, 2, 3, 4]) expect(afterMerge.bodyMd).toContain(agentContentOf(number));
  });

  it('refuses a stale write on a section another writer changed, names it in the message and writes nothing', async () => {
    await bootPlainProject();
    const firstAgent = await agentInProject();
    const secondAgent = await agentInProject();
    const note = await createNoteWithFiveSections();
    const firstWrite = parsed(await writeSection(firstAgent, note.id, 1, note.rev));

    const refused = await writeSection(secondAgent, note.id, 1, note.rev, 'second agent overwrite');
    const afterRefusal = await readNote(note.id);

    expect(refused.isError).toBe(true);
    expect(errorTextOf(refused)).toMatch(new RegExp(`^error stale_revision: .*current rev: ${firstWrite.rev}\\. .*Conflicting sections: Section 1\\.`));
    expect(afterRefusal.rev).toBe(firstWrite.rev);
    expect(afterRefusal.bodyMd).toContain(agentContentOf(1));
    expect(afterRefusal.bodyMd).not.toContain('second agent overwrite');
  });

  it('refuses a stale write whose section was deleted since expected_rev', async () => {
    await bootPlainProject();
    const agent = await agentInProject();
    const note = await createNoteWithFiveSections();
    const bodyWithoutSectionOne = originalBody.replace(`## ${sectionHeading(1)}\noriginal 1\n\n`, '');
    const current = parsed(await agent.callTool({ name: 'update_note', arguments: { note: note.id, body_md: bodyWithoutSectionOne, expected_rev: note.rev } }));

    const refused = await writeSection(agent, note.id, 1, note.rev);

    expect(refused.isError).toBe(true);
    expect(errorTextOf(refused)).toMatch(new RegExp(`^error stale_revision: .*current rev: ${current.rev}\\. .*Conflicting sections: Section 1\\.`));
  });

  it('refuses a stale write on a body that has no sections', async () => {
    await bootPlainProject();
    const agent = await agentInProject();
    const created = await adminApi('/api/notes', { method: 'POST', body: JSON.stringify({ projectId: PROJECT_ID, title: 'Plain', bodyMd: 'just text' }) });
    const note = (await created.json()) as NoteOverRest;
    await agent.callTool({ name: 'append_to_note', arguments: { note: note.id, content: 'more text' } });

    const refused = await writeSection(agent, note.id, 1, note.rev);

    expect(refused.isError).toBe(true);
    expect(errorTextOf(refused)).toMatch(/^error stale_revision: /);
  });

  it('refuses a stale write when the heading is ambiguous in the current revision', async () => {
    await bootPlainProject();
    const agent = await agentInProject();
    const note = await createNoteWithFiveSections();
    await agent.callTool({ name: 'append_to_note', arguments: { note: note.id, content: `\n## ${sectionHeading(2)}\nduplicate` } });

    const refused = await writeSection(agent, note.id, 2, note.rev);

    expect(refused.isError).toBe(true);
    expect(errorTextOf(refused)).toMatch(/^error stale_revision: .*Conflicting sections: Section 2\./);
  });

  it('keeps both writes when two agents write disjoint sections at the same time', async () => {
    await bootPlainProject();
    const firstAgent = await agentInProject();
    const secondAgent = await agentInProject();
    const note = await createNoteWithFiveSections();

    const [first, second] = await Promise.all([writeSection(firstAgent, note.id, 1, note.rev), writeSection(secondAgent, note.id, 2, note.rev)]);
    const afterRace = await readNote(note.id);

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    expect(afterRace.rev).toBe(note.rev + 2);
    expect(afterRace.bodyMd).toContain(agentContentOf(1));
    expect(afterRace.bodyMd).toContain(agentContentOf(2));
  });

  it('keeps exactly one write and refuses the other when two agents write the same section at the same time', async () => {
    await bootPlainProject();
    const firstAgent = await agentInProject();
    const secondAgent = await agentInProject();
    const note = await createNoteWithFiveSections();

    const results = await Promise.all([writeSection(firstAgent, note.id, 1, note.rev, 'RACE-ALPHA'), writeSection(secondAgent, note.id, 1, note.rev, 'RACE-BETA')]);
    const afterRace = await readNote(note.id);
    const refusals = results.filter((result) => result.isError);

    expect(refusals).toHaveLength(1);
    expect(errorTextOf(refusals[0])).toMatch(/^error stale_revision: /);
    expect(afterRace.rev).toBe(note.rev + 1);
    expect([afterRace.bodyMd.includes('RACE-ALPHA'), afterRace.bodyMd.includes('RACE-BETA')].filter(Boolean)).toHaveLength(1);
  });

  it('merges on a file-backed note and writes both sections to the file', async () => {
    const docsFolder = tempDirs.make('of-stale-84-merge-docs-');
    mkdirSync(join(docsFolder, 'specs'));
    const noteFile = join(docsFolder, 'specs', `${FILE_BACKED_NOTE_TITLE}.md`);
    writeFileSync(noteFile, originalBody);
    await bootDaemon((projects) => projects.insert({ id: PROJECT_ID, name: 'One', docsFolderPath: docsFolder, createdAt: 't0' }));
    const agent = await agentInProject();
    const noteId = (daemon.db.prepare('SELECT id FROM notes WHERE title = ?').get(FILE_BACKED_NOTE_TITLE) as { id: string }).id;
    const baseRev = (await readNote(noteId)).rev;
    await writeSection(agent, noteId, 1, baseRev);

    const merged = parsed(await writeSection(agent, noteId, 2, baseRev));

    expect(merged.merged).toBe(true);
    const fileOnDisk = readFileSync(noteFile, 'utf8');
    expect(fileOnDisk).toContain(agentContentOf(1));
    expect(fileOnDisk).toContain(agentContentOf(2));
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
