import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E_FLAG_ENV, E2E_FLAG_ON } from '@openfleet/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon, type DaemonOptions } from '../daemon.js';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const RESETTING_SOURCES = ['startup', 'compact', 'clear', 'resume'] as const;
const PROJECT_ID = randomUUID();
const BODY_BYTES_NEEDING_PAGES = 60 * 1024;

const tempDirs = createTempDirTracker();
const openClients: Client[] = [];

interface SpawnAnswer { id: string; warnings?: { code: string; message: string }[] }
type Json = Record<string, unknown>;

const textOf = (result: unknown): string => (result as { content: { text: string }[] }).content[0]!.text;
const jsonOf = (result: unknown): Json => JSON.parse(textOf(result)) as Json;

interface Rig {
  daemon: Daemon;
  aManager: (name: string) => Promise<{ id: string }>;
  aNote: (title: string, bodyMd: string) => Promise<{ id: string; rev: number }>;
  aNoteOfAnotherProject: (title: string, bodyMd: string) => Promise<{ id: string }>;
  linkMissionNote: (managerId: string, noteId: string) => Promise<void>;
  reviseNote: (note: { id: string; rev: number }, bodyMd: string) => Promise<void>;
  mcpClientOf: (sessionId: string) => Promise<Client>;
  getNote: (client: Client, noteId: string, args?: Json) => Promise<Json>;
  readAllPagesOf: (client: Client, noteId: string) => Promise<Json[]>;
  spawnChild: (client: Client, name: string) => Promise<{ isError: boolean | undefined; text: string; answer: SpawnAnswer }>;
  sessionStart: (sessionId: string, source: string) => Promise<void>;
  managerViewOf: (managerId: string) => Promise<{ noteNotReadWarningCount?: number; deniedCommandCount?: number }>;
  pulseBodiesOf: (managerId: string) => Promise<string[]>;
}

async function startRig(options: DaemonOptions): Promise<Rig> {
  const config: Config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-note-guard-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  mkdirSync(config.worktreesRoot, { recursive: true });
  const seedDb = openDatabase(config.dbPath);
  new ProjectRepository(seedDb).insert({ id: PROJECT_ID, name: 'Fleet', docsFolderPath: null, createdAt: 't0' });
  seedDb.close();
  const daemon = await startDaemon(config, options);
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...(init.headers ?? {}) } });
  const callTool = (client: Client, name: string, args: Json = {}) => client.callTool({ name, arguments: args });
  const readBase = (client: Client) => callTool(client, 'get_manager_base');
  const getNote: Rig['getNote'] = async (client, noteId, args = {}) => jsonOf(await callTool(client, 'get_note', { note: noteId, ...args }));
  return {
    daemon,
    aManager: async (name) => (await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: tempDirs.make('of-note-guard-wt-'), harness: 'fake', emoji: '🧭', name, projectId: PROJECT_ID, manager: { pulseSeconds: 3600, childrenCap: 5, mission: 'Ship the fleet' } }) })).json()) as { id: string },
    aNote: async (title, bodyMd) => {
      const created = (await (await api('/api/notes', { method: 'POST', body: JSON.stringify({ projectId: PROJECT_ID, title, bodyMd }) })).json()) as { id?: string; rev?: number; data?: { id: string; rev: number } };
      return { id: created.id ?? created.data!.id, rev: created.rev ?? created.data!.rev };
    },
    aNoteOfAnotherProject: async (title, bodyMd) => {
      const otherProjectId = randomUUID();
      new ProjectRepository(daemon.db).insert({ id: otherProjectId, name: 'Elsewhere', docsFolderPath: null, createdAt: 't0' });
      const created = (await (await api('/api/notes', { method: 'POST', body: JSON.stringify({ projectId: otherProjectId, title, bodyMd }) })).json()) as { id?: string; data?: { id: string } };
      return { id: created.id ?? created.data!.id };
    },
    linkMissionNote: async (managerId, noteId) => {
      const response = await api(`/api/managers/${managerId}`, { method: 'PATCH', body: JSON.stringify({ missionNoteId: noteId }) });
      expect(response.status).toBe(200);
    },
    reviseNote: async ({ id, rev }, bodyMd) => {
      const response = await api(`/api/notes/${id}`, { method: 'PATCH', body: JSON.stringify({ projectId: PROJECT_ID, expectedRev: rev, bodyMd }) });
      expect(response.status).toBe(200);
    },
    mcpClientOf: async (sessionId) => {
      const { mcp_token } = daemon.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(sessionId) as { mcp_token: string };
      const client = new Client({ name: 'note-guard', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${daemon.server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcp_token}` } } }));
      openClients.push(client);
      return client;
    },
    getNote,
    readAllPagesOf: async (client, noteId) => {
      const pages: Json[] = [];
      let offset = 0;
      for (;;) {
        pages.push(await getNote(client, noteId, { offset }));
        const nextOffset = pages.at(-1)!.nextOffset;
        if (typeof nextOffset !== 'number') return pages;
        offset = nextOffset;
      }
    },
    spawnChild: async (client, name) => {
      await readBase(client);
      const directory = join(config.worktreesRoot, name);
      mkdirSync(directory, { recursive: true });
      const result = await callTool(client, 'create_session', { directory, name });
      const text = textOf(result);
      return { isError: result.isError as boolean | undefined, text, answer: result.isError ? { id: '' } : (JSON.parse(text) as SpawnAnswer) };
    },
    sessionStart: async (sessionId, source) => {
      const { hook_token } = daemon.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(sessionId) as { hook_token: string };
      await fetch(`${daemon.server.url}/hooks/${hook_token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', hook_event_name: 'SessionStart', source }) });
    },
    managerViewOf: async (managerId) => ((await (await api(`/api/managers/${managerId}`)).json()) as { manager: { noteNotReadWarningCount?: number; deniedCommandCount?: number } }).manager,
    pulseBodiesOf: async (managerId) => {
      await api(`/api/managers/${managerId}/pulse`, { method: 'POST' });
      return (daemon.db.prepare('SELECT body FROM message_queue WHERE session_id = ? AND body LIKE ?').all(managerId, '[pulse]%') as { body: string }[]).map((row) => row.body);
    },
  };
}

const noteWarningOf = (answer: SpawnAnswer) => answer.warnings?.find(({ code }) => code === 'note_not_read');

async function aManagerWithMissionNote(rig: Rig, { name, bodyMd = '# Mission\n\nShip the fleet.' }: { name: string; bodyMd?: string }) {
  const manager = await rig.aManager(name);
  const note = await rig.aNote(`${name} mission`, bodyMd);
  await rig.linkMissionNote(manager.id, note.id);
  return { manager, note, client: await rig.mcpClientOf(manager.id) };
}

/** A mission note that needs several pages and mentions two small notes, so a full read is pages plus both mentions. */
async function aManagerWithPagedMissionNote(rig: Rig, name: string) {
  const mentionIds = [(await rig.aNote(`${name} annex A`, 'annex A')).id, (await rig.aNote(`${name} annex B`, 'annex B')).id];
  const mentions = mentionIds.map((id) => `@note:${id}`).join(' ');
  const body = `${mentions}\n${'a line of the mission\n'.repeat(Math.ceil(BODY_BYTES_NEEDING_PAGES / 22))}`.slice(0, BODY_BYTES_NEEDING_PAGES);
  return { ...(await aManagerWithMissionNote(rig, { name, bodyMd: body })), mentionIds };
}

const linesOfBytes = (byteCount: number, line = 'a line of the note\n') => line.repeat(Math.ceil(byteCount / line.length)).slice(0, byteCount);

/** A mission note over the read cap that mentions one note annex and one table, which no get_note can read. */
async function aManagerWithNoteAnnexAndTableMentions(rig: Rig, { name, annexBodyMd }: { name: string; annexBodyMd: string }) {
  const annex = await rig.aNote(`${name} annex`, annexBodyMd);
  const body = `@note:${annex.id} @table:${name}-store\n${linesOfBytes(BODY_BYTES_NEEDING_PAGES / 2)}`;
  return { ...(await aManagerWithMissionNote(rig, { name, bodyMd: body })), annexId: annex.id };
}

/** A mission note over the read cap whose first lines are `mentionLines`, so a full read is its pages plus what the lines mention. */
async function aManagerWithMissionMentioning(rig: Rig, { name, mentionLines }: { name: string; mentionLines: string }) {
  const bodyMd = `${mentionLines}\n${linesOfBytes(BODY_BYTES_NEEDING_PAGES)}`;
  return aManagerWithMissionNote(rig, { name, bodyMd });
}

const ANNEX_BYTES_FITTING_THE_READ_CAP = 14 * 1024;

/** A note annex that fits the read cap alone but not with its own mentioned note expanded after it, so get_note answers it as a body with a mentions index. */
async function aNestedAnnex(rig: Rig, name: string) {
  const inner = await rig.aNote(`${name} inner`, linesOfBytes(ANNEX_BYTES_FITTING_THE_READ_CAP));
  const annex = await rig.aNote(`${name} annex`, `@note:${inner.id}\n${linesOfBytes(ANNEX_BYTES_FITTING_THE_READ_CAP)}`);
  return { inner, annex };
}

const closeRig = async (rig: Rig | undefined) => { await Promise.all(openClients.splice(0).map((client) => client.close())); await rig?.daemon.close(); };

describe('the note_not_read warning when the enforcement is the default', () => {
  let rig: Rig;
  beforeAll(async () => { rig = await startRig({}); });
  afterAll(async () => { await closeRig(rig); tempDirs.removeAll(); });

  it('lets a spawn pass without a warning after the mission note was read whole', async () => {
    const { client, note } = await aManagerWithMissionNote(rig, { name: 'Whole-reader' });
    await rig.getNote(client, note.id);

    const { isError, answer } = await rig.spawnChild(client, 'whole-reader-child');

    expect(isError).toBeUndefined();
    expect(noteWarningOf(answer)).toBeUndefined();
  });

  it('lets a spawn pass with a note_not_read warning when the manager read nothing', async () => {
    const { client } = await aManagerWithMissionNote(rig, { name: 'Non-reader' });

    const { isError, answer } = await rig.spawnChild(client, 'non-reader-child');

    expect(isError).toBeUndefined();
    expect(answer.id).toBeTruthy();
    expect(noteWarningOf(answer)?.message).toContain('Call get_note on your mission note');
  });

  it('tells a warned manager that its child was created, so it must not spawn the same child again', async () => {
    const { client } = await aManagerWithMissionNote(rig, { name: 'Warned-once' });

    const { answer } = await rig.spawnChild(client, 'warned-once-child');

    const message = noteWarningOf(answer)?.message ?? '';
    expect(message).toContain('child is created');
    expect(message).not.toContain('no child is spawned');
    expect(message).not.toContain('then spawn again');
  });

  it('warns a manager that read only the first page of its note', async () => {
    const { client, note } = await aManagerWithPagedMissionNote(rig, 'First-page-reader');
    await rig.getNote(client, note.id);

    const { isError, answer } = await rig.spawnChild(client, 'first-page-child');

    expect(isError).toBeUndefined();
    expect(noteWarningOf(answer)).toBeDefined();
  });

  it('warns a manager that read every page but none of the mentions', async () => {
    const { client, note } = await aManagerWithPagedMissionNote(rig, 'Pages-only-reader');
    await rig.readAllPagesOf(client, note.id);

    const { answer } = await rig.spawnChild(client, 'pages-only-child');

    expect(noteWarningOf(answer)).toBeDefined();
  });

  it('warns a manager that read the mentions but skipped a page', async () => {
    const { client, note, mentionIds } = await aManagerWithPagedMissionNote(rig, 'Gap-reader');
    const firstPage = await rig.getNote(client, note.id, { offset: 0 });
    await rig.getNote(client, note.id, { offset: (firstPage.nextOffset as number) * 2 });
    for (const mentionId of mentionIds) await rig.getNote(client, mentionId);

    const { answer } = await rig.spawnChild(client, 'gap-reader-child');

    expect(noteWarningOf(answer)).toBeDefined();
  });

  it('lets a spawn pass without a warning after every contiguous page and every mention was read', async () => {
    const { client, note, mentionIds } = await aManagerWithPagedMissionNote(rig, 'Full-paged-reader');
    await rig.readAllPagesOf(client, note.id);
    for (const mentionId of mentionIds) await rig.getNote(client, mentionId);

    const { isError, answer } = await rig.spawnChild(client, 'full-paged-child');

    expect(isError).toBeUndefined();
    expect(noteWarningOf(answer)).toBeUndefined();
  });

  it('lets a spawn pass without a warning after every page and the note annex were read, though the table mention cannot be read', async () => {
    const { client, note, annexId } = await aManagerWithNoteAnnexAndTableMentions(rig, { name: 'Annex-reader', annexBodyMd: 'annex' });
    await rig.readAllPagesOf(client, note.id);
    await rig.getNote(client, annexId);

    const { isError, answer } = await rig.spawnChild(client, 'annex-reader-child');

    expect(isError).toBeUndefined();
    expect(noteWarningOf(answer)).toBeUndefined();
  });

  it('warns a manager that read every page but not the note annex, even with a table mention in the note', async () => {
    const { client, note } = await aManagerWithNoteAnnexAndTableMentions(rig, { name: 'Annex-skipper', annexBodyMd: 'annex' });
    await rig.readAllPagesOf(client, note.id);

    const { answer } = await rig.spawnChild(client, 'annex-skipper-child');

    expect(noteWarningOf(answer)).toBeDefined();
  });

  it('lets a spawn pass without a warning when the note annex, over the read cap, was read by contiguous pages', async () => {
    const { client, note, annexId } = await aManagerWithNoteAnnexAndTableMentions(rig, { name: 'Paged-annex-reader', annexBodyMd: linesOfBytes(40 * 1024) });
    await rig.readAllPagesOf(client, note.id);
    const annexPages = await rig.readAllPagesOf(client, annexId);

    const { isError, answer } = await rig.spawnChild(client, 'paged-annex-child');

    expect(annexPages.length).toBeGreaterThan(1);
    expect(isError).toBeUndefined();
    expect(noteWarningOf(answer)).toBeUndefined();
  });

  it('warns a manager that read a single page of a note annex over the read cap', async () => {
    const { client, note, annexId } = await aManagerWithNoteAnnexAndTableMentions(rig, { name: 'One-page-annex-reader', annexBodyMd: linesOfBytes(40 * 1024) });
    await rig.readAllPagesOf(client, note.id);
    await rig.getNote(client, annexId);

    const { answer } = await rig.spawnChild(client, 'one-page-annex-child');

    expect(noteWarningOf(answer)).toBeDefined();
  });

  describe('a note annex that mentions a note itself', () => {
    it('lets a spawn pass without a warning after every page and the annex were read, though the annex answers as a body with a mentions index', async () => {
      const { annex } = await aNestedAnnex(rig, 'Nested-annex-reader');
      const { client, note } = await aManagerWithMissionMentioning(rig, { name: 'Nested-annex-reader', mentionLines: `@note:${annex.id}` });
      await rig.readAllPagesOf(client, note.id);
      const annexAnswer = await rig.getNote(client, annex.id);

      const { isError, answer } = await rig.spawnChild(client, 'nested-annex-child');

      expect(annexAnswer).toMatchObject({ complete: false });
      expect(annexAnswer.offset).toBeUndefined();
      expect(isError).toBeUndefined();
      expect(noteWarningOf(answer)).toBeUndefined();
    });

    it('warns a manager that read every page but not the annex', async () => {
      const { annex } = await aNestedAnnex(rig, 'Nested-annex-skipper');
      const { client, note } = await aManagerWithMissionMentioning(rig, { name: 'Nested-annex-skipper', mentionLines: `@note:${annex.id}` });
      await rig.readAllPagesOf(client, note.id);

      const { answer } = await rig.spawnChild(client, 'nested-skipper-child');

      expect(noteWarningOf(answer)?.message).toContain('Call get_note on your mission note');
      expect(noteWarningOf(answer)?.message).toContain('child is created');
    });

    it('does not owe the note the annex mentions, since only the mentions written in the mission note are owed', async () => {
      const { annex, inner } = await aNestedAnnex(rig, 'Inner-not-owed');
      const { client, note, manager } = await aManagerWithMissionMentioning(rig, { name: 'Inner-not-owed', mentionLines: `@note:${annex.id}` });
      await rig.readAllPagesOf(client, note.id);
      await rig.getNote(client, annex.id);

      await rig.spawnChild(client, 'inner-not-owed-child');

      expect(inner.id).not.toBe(annex.id);
      expect((await rig.managerViewOf(manager.id)).noteNotReadWarningCount).toBe(0);
    });
  });

  describe('the mentions of the mission note that need care', () => {
    it('owes one read for a note mentioned twice in the mission note', async () => {
      const annex = await rig.aNote('Twice annex', 'annex');
      const { client, note } = await aManagerWithMissionMentioning(rig, { name: 'Twice-mentioned', mentionLines: `@note:${annex.id} and again @note:${annex.id}` });
      await rig.readAllPagesOf(client, note.id);
      await rig.getNote(client, annex.id);

      const { answer } = await rig.spawnChild(client, 'twice-mentioned-child');

      expect(noteWarningOf(answer)).toBeUndefined();
    });

    it('does not owe a mention of a note that does not exist', async () => {
      const { client, note } = await aManagerWithMissionMentioning(rig, { name: 'Ghost-mention', mentionLines: `@note:${randomUUID()}` });
      await rig.readAllPagesOf(client, note.id);

      const { answer } = await rig.spawnChild(client, 'ghost-mention-child');

      expect(noteWarningOf(answer)).toBeUndefined();
    });

    it('does not owe a mention of a note of another project', async () => {
      const foreign = await rig.aNoteOfAnotherProject('Foreign annex', 'foreign');
      const { client, note } = await aManagerWithMissionMentioning(rig, { name: 'Foreign-mention', mentionLines: `@note:${foreign.id}` });
      await rig.readAllPagesOf(client, note.id);

      const { answer } = await rig.spawnChild(client, 'foreign-mention-child');

      expect(noteWarningOf(answer)).toBeUndefined();
    });

    it('owes a mention written in a code block, because the mentions index lists it like any other', async () => {
      const annex = await rig.aNote('Fenced annex', 'annex');
      const fencedMention = '```\n@note:' + annex.id + '\n```';
      const { client, note } = await aManagerWithMissionMentioning(rig, { name: 'Fenced-mention', mentionLines: fencedMention });
      await rig.readAllPagesOf(client, note.id);
      const beforeReadingAnnex = await rig.spawnChild(client, 'fenced-before-child');
      await rig.getNote(client, annex.id);
      const afterReadingAnnex = await rig.spawnChild(client, 'fenced-after-child');

      expect(noteWarningOf(beforeReadingAnnex.answer)).toBeDefined();
      expect(noteWarningOf(afterReadingAnnex.answer)).toBeUndefined();
    });
  });

  it('counts the pages read from the last to the first as a full read of the mission note', async () => {
    const reader = await aManagerWithMissionMentioning(rig, { name: 'Backwards-reader', mentionLines: '' });
    const scout = await aManagerWithMissionNote(rig, { name: 'Backwards-scout' });
    const pagesInOrder = await rig.readAllPagesOf(scout.client, reader.note.id);
    const offsets = pagesInOrder.map((page) => page.offset as number);

    for (const offset of offsets.toReversed()) await rig.getNote(reader.client, reader.note.id, { offset });
    const { answer } = await rig.spawnChild(reader.client, 'backwards-child');

    expect(offsets.length).toBeGreaterThan(1);
    expect(noteWarningOf(answer)).toBeUndefined();
  });

  it('warns a manager that read the pages from the last to the first but left one out', async () => {
    const reader = await aManagerWithMissionMentioning(rig, { name: 'Backwards-gap', mentionLines: '' });
    const scout = await aManagerWithMissionNote(rig, { name: 'Backwards-gap-scout' });
    const offsets = (await rig.readAllPagesOf(scout.client, reader.note.id)).map((page) => page.offset as number);

    for (const offset of offsets.slice(1).toReversed()) await rig.getNote(reader.client, reader.note.id, { offset });
    const { answer } = await rig.spawnChild(reader.client, 'backwards-gap-child');

    expect(noteWarningOf(answer)).toBeDefined();
  });

  it('warns a manager whose note changed after it read the note in full', async () => {
    const { client, note } = await aManagerWithMissionNote(rig, { name: 'Stale-reader' });
    await rig.getNote(client, note.id);
    await rig.reviseNote(note, '# Mission\n\nA new direction.');

    const stale = await rig.spawnChild(client, 'stale-child');
    await rig.getNote(client, note.id);
    const reread = await rig.spawnChild(client, 'reread-child');

    expect(noteWarningOf(stale.answer)).toBeDefined();
    expect(noteWarningOf(reread.answer)).toBeUndefined();
  });

  it('does not judge a manager without a linked mission note', async () => {
    const manager = await rig.aManager('Noteless');
    const client = await rig.mcpClientOf(manager.id);

    const { isError, answer } = await rig.spawnChild(client, 'noteless-child');

    expect(isError).toBeUndefined();
    expect(answer.warnings ?? []).toEqual([]);
  });

  it('does not count the read of another note than the mission note', async () => {
    const { client } = await aManagerWithMissionNote(rig, { name: 'Other-note-reader' });
    const other = await rig.aNote('Other', 'something else');
    await rig.getNote(client, other.id);

    const { answer } = await rig.spawnChild(client, 'other-note-child');

    expect(noteWarningOf(answer)).toBeDefined();
  });

  it.each(RESETTING_SOURCES)('warns after a SessionStart with source %s, then lets a spawn pass after the note is read again', async (source) => {
    const { manager, client, note } = await aManagerWithMissionNote(rig, { name: `Reset-${source}` });
    await rig.getNote(client, note.id);
    expect(noteWarningOf((await rig.spawnChild(client, `before-${source}`)).answer)).toBeUndefined();

    await rig.sessionStart(manager.id, source);
    const afterReset = await rig.spawnChild(client, `after-${source}`);
    await rig.getNote(client, note.id);
    const afterReread = await rig.spawnChild(client, `reread-${source}`);

    expect(noteWarningOf(afterReset.answer)).toBeDefined();
    expect(afterReread.isError).toBeUndefined();
    expect(noteWarningOf(afterReread.answer)).toBeUndefined();
  });

  it('keeps the read of a manager when another event than a session start happens', async () => {
    const { manager, client, note } = await aManagerWithMissionNote(rig, { name: 'Steady-reader' });
    await rig.getNote(client, note.id);

    await rig.sessionStart(manager.id, 'unknown-source');

    expect(noteWarningOf((await rig.spawnChild(client, 'steady-child')).answer)).toBeUndefined();
  });

  it('never refuses a spawn by default, and creates the child', async () => {
    const { manager, client } = await aManagerWithMissionNote(rig, { name: 'Never-refused' });

    const { isError, answer } = await rig.spawnChild(client, 'never-refused-child');

    expect(isError).toBeUndefined();
    expect(noteWarningOf(answer)).toBeDefined();
    expect(rig.daemon.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE parent_id = ?').get(manager.id)).toEqual({ count: 1 });
  });
});

describe('the pulse that follows a reset of the context', () => {
  const REMINDER = 'context compacted: re-read your mission note in full with get_note';
  let rig: Rig;
  beforeAll(async () => { rig = await startRig({}); });
  afterAll(async () => { await closeRig(rig); tempDirs.removeAll(); });

  const lastPulseOf = async (managerId: string) => (await rig.pulseBodiesOf(managerId)).at(-1) ?? '';

  it.each(RESETTING_SOURCES)('reminds the manager to re-read its mission note in full after a SessionStart with source %s', async (source) => {
    const { manager, client, note } = await aManagerWithMissionNote(rig, { name: `Pulse-reset-${source}` });
    await rig.getNote(client, note.id);
    await rig.sessionStart(manager.id, source);

    expect(await lastPulseOf(manager.id)).toContain(REMINDER);
  });

  it('stops reminding once the manager read its mission note in full again', async () => {
    const { manager, client, note } = await aManagerWithMissionNote(rig, { name: 'Pulse-reread' });
    await rig.sessionStart(manager.id, 'compact');
    await rig.getNote(client, note.id);

    expect(await lastPulseOf(manager.id)).not.toContain(REMINDER);
  });

  it('does not remind a manager whose context was never reset', async () => {
    const { manager } = await aManagerWithMissionNote(rig, { name: 'Pulse-no-reset' });

    expect(await lastPulseOf(manager.id)).not.toContain(REMINDER);
  });

  it('does not remind a manager without a mission note', async () => {
    const manager = await rig.aManager('Pulse-noteless');
    await rig.sessionStart(manager.id, 'compact');

    expect(await lastPulseOf(manager.id)).not.toContain(REMINDER);
  });
});

describe('the count of note_not_read warnings of a manager over 48 hours', () => {
  const HOURS_TO_MS = 3_600_000;
  let rig: Rig;
  beforeAll(async () => { rig = await startRig({}); });
  afterAll(async () => { await closeRig(rig); tempDirs.removeAll(); });

  const journalRowsOf = (managerId: string) => rig.daemon.db.prepare('SELECT rule_id, outcome, tool_name, created_at FROM denied_commands WHERE manager_id = ? ORDER BY created_at').all(managerId) as { rule_id: string; outcome: string; tool_name: string; created_at: string }[];

  it('counts each warning the manager received, and journals it as an observed note_not_read', async () => {
    const { manager, client } = await aManagerWithMissionNote(rig, { name: 'Counted' });
    await rig.spawnChild(client, 'counted-1');
    await rig.spawnChild(client, 'counted-2');

    const view = await rig.managerViewOf(manager.id);

    expect(view.noteNotReadWarningCount).toBe(2);
    expect(journalRowsOf(manager.id)).toMatchObject([{ rule_id: 'note_not_read', outcome: 'observed', tool_name: 'create_session' }, { rule_id: 'note_not_read', outcome: 'observed', tool_name: 'create_session' }]);
  });

  it('shows the count to the manager in get_argus_status', async () => {
    const { client } = await aManagerWithMissionNote(rig, { name: 'Counted-status' });
    await rig.spawnChild(client, 'counted-status-1');

    const status = jsonOf(await client.callTool({ name: 'get_argus_status', arguments: {} })) as { manager: { noteNotReadWarningCount: number } };

    expect(status.manager.noteNotReadWarningCount).toBe(1);
  });

  it('counts nothing for a spawn after a full read, and keeps the refusal count of commands at zero', async () => {
    const { manager, client, note } = await aManagerWithMissionNote(rig, { name: 'Counted-none' });
    await rig.getNote(client, note.id);
    await rig.spawnChild(client, 'counted-none-1');

    const view = await rig.managerViewOf(manager.id);

    expect(view.noteNotReadWarningCount).toBe(0);
    expect(view.deniedCommandCount).toBe(0);
    expect(journalRowsOf(manager.id)).toEqual([]);
  });

  it('forgets the warnings older than 48 hours', async () => {
    const { manager, client } = await aManagerWithMissionNote(rig, { name: 'Counted-old' });
    await rig.spawnChild(client, 'counted-old-1');
    await rig.spawnChild(client, 'counted-old-2');
    const fortyNineHoursAgo = new Date(Date.now() - 49 * HOURS_TO_MS).toISOString();
    rig.daemon.db.prepare('UPDATE denied_commands SET created_at = ? WHERE id = (SELECT id FROM denied_commands WHERE manager_id = ? LIMIT 1)').run(fortyNineHoursAgo, manager.id);

    const view = await rig.managerViewOf(manager.id);

    expect(view.noteNotReadWarningCount).toBe(1);
  });

  it('counts the warnings of each manager apart', async () => {
    const first = await aManagerWithMissionNote(rig, { name: 'Counted-first' });
    const second = await aManagerWithMissionNote(rig, { name: 'Counted-second' });
    await rig.spawnChild(first.client, 'counted-first-1');

    expect((await rig.managerViewOf(first.manager.id)).noteNotReadWarningCount).toBe(1);
    expect((await rig.managerViewOf(second.manager.id)).noteNotReadWarningCount).toBe(0);
  });
});

describe('the note_not_read refusal when the enforcement is injected as refuse', () => {
  let rig: Rig;
  beforeAll(async () => { rig = await startRig({ noteNotReadEnforcement: 'refuse' }); });
  afterAll(async () => { await closeRig(rig); tempDirs.removeAll(); });

  it('refuses a spawn until the mission note is read in full, and creates no child', async () => {
    const { manager, client, note } = await aManagerWithMissionNote(rig, { name: 'Refused-reader' });

    const refused = await rig.spawnChild(client, 'refused-child');
    await rig.getNote(client, note.id);
    const accepted = await rig.spawnChild(client, 'accepted-child');

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('note_not_read');
    expect(refused.text).toContain('Call get_note on your mission note');
    expect(refused.text).toContain('no child is spawned');
    expect(refused.text).toContain('then spawn again');
    expect(accepted.isError).toBeUndefined();
    expect(accepted.answer.warnings).toBeUndefined();
    expect(rig.daemon.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE parent_id = ?').get(manager.id)).toEqual({ count: 1 });
  });
});
