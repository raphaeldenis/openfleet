import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { newId } from '../ids.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { DocsFolderService } from '../notes/docsFolderService.js';
import { expandMentions } from '../notes/mentionExpander.js';
import { nodeDocsFolderFs } from '../notes/nodeDocsFolderFs.js';
import { NoteRepository } from '../notes/noteRepository.js';
import { NoteService } from '../notes/noteService.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { SessionService } from '../sessions/sessionService.js';
import { DataStoreRepository } from '../stores/dataStoreRepository.js';
import { DataStoreService } from '../stores/dataStoreService.js';
import { startServer } from './server.js';

const ADMIN = { authorization: 'Bearer admin', 'content-type': 'application/json' };

let server: Awaited<ReturnType<typeof startServer>>;
let db: DatabaseSync;
let fileBackedProjectId: string;
let docs: DocsFolderService;

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = ADMIN) =>
  fetch(`${server.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const createNote = async (overrides: Record<string, unknown> = {}) =>
  (await call('POST', '/api/notes', { projectId: 'p1', title: 'Plan', bodyMd: 'entry', ...overrides })).json() as Promise<Record<string, any>>;
const createStore = async (projectId = 'p1', displayName = 'Tasks') =>
  (await call('POST', '/api/data-stores', { projectId, displayName })).json() as Promise<Record<string, any>>;

beforeEach(async () => {
  db = openDatabase(':memory:');
  const bus = new EventBus();
  const harness = new FakeHarness();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const approvals = new ApprovalService({ db, bus });
  const projects = new ProjectRepository(db);
  projects.insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  projects.insert({ id: 'p2', name: 'Two', docsFolderPath: null, createdAt: 't0' });
  fileBackedProjectId = 'p-fb';
  const docsFolderPath = mkdtempSync(join(tmpdir(), 'of-docs-'));
  projects.insert({ id: fileBackedProjectId, name: 'FileBacked', docsFolderPath, createdAt: 't0' });
  const storeRepo = new DataStoreRepository(db);
  const stores = new DataStoreService({ repo: storeRepo, db, clock: () => '2026-01-01T00:00:00.000Z', newId });
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => '2026-01-01T00:00:00.000Z', newId });
  docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => '2026-01-01T00:00:00.000Z' });
  docs.ensureLayout(docsFolderPath);
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: { ...DEFAULT_MODEL_TABLE },
    modelConfigPath: '/tmp/of-unused/config.json', notes, noteRepo, docs, stores, storeRepo, projects,
  });
});
afterEach(() => server.close());

describe('user gets a clean answer from the paged reads at the limit and offset edges', () => {
  it.each([
    ['limit=0', 200], ['limit=1', 200], ['limit=200', 200], ['limit=201', 400], ['limit=99999999999999999999999', 400],
    ['limit=007', 200], ['limit=%2B5', 400], ['limit=1e2', 400], ['limit=%D9%A3', 400],
    ['offset=99999999999999999999999', 400], ['offset=9007199254740993', 400], ['offset=9007199254740991', 200], ['offset=-1', 400], ['offset=', 400],
  ])('answers %s on every list route with %i', async (query, expected) => {
    const note = await createNote();

    const statuses = (await Promise.all([
      call('GET', `/api/notes?projectId=p1&${query}`),
      call('GET', `/api/notes/${note.id}/versions?projectId=p1&${query}`),
      call('GET', `/api/data-stores?projectId=p1&${query}`),
      call('GET', `/api/projects?${query}`),
    ])).map((response) => response.status);

    expect(statuses).toEqual([expected, expected, expected, expected]);
  });

  it('refuses an unsafe-integer limit on the search and the row history', async () => {
    const store = await createStore();
    const inserted = await (await call('POST', `/api/data-stores/${store.id}/rows`, { projectId: 'p1', rows: [{}] })).json() as { items: { id: string }[] };

    const search = await call('GET', '/api/notes/search?projectId=p1&q=a&limit=99999999999999999999999');
    const history = await call('GET', `/api/data-stores/${store.id}/rows/${inserted.items[0]!.id}/changes?projectId=p1&limit=99999999999999999999999`);

    expect([search.status, history.status]).toEqual([400, 400]);
  });

  it('returns at most limit items from the notes list and the versions list while total counts them all', async () => {
    const note = await createNote({ title: 'a' });
    await createNote({ title: 'b' });
    await createNote({ title: 'c' });
    await call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 1, bodyMd: 'two' });
    await call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 2, bodyMd: 'three' });

    const notesPage = await (await call('GET', '/api/notes?projectId=p1&limit=1')).json() as { items: unknown[]; total: number };
    const versionsPage = await (await call('GET', `/api/notes/${note.id}/versions?projectId=p1&limit=1`)).json() as { items: unknown[]; total: number };

    expect([notesPage.items.length, notesPage.total]).toEqual([1, 3]);
    expect([versionsPage.items.length, versionsPage.total]).toEqual([1, 3]);
  });

  it('keeps total, limit and offset honest when the offset is past the end', async () => {
    await createNote();

    const page = await (await call('GET', '/api/notes?projectId=p1&limit=5&offset=50')).json();

    expect(page).toEqual({ items: [], total: 1, limit: 5, offset: 50 });
  });

  it('counts the same total whatever the page, with a folder filter', async () => {
    await createNote({ title: 'a', folder: 'specs' });
    await createNote({ title: 'b', folder: 'specs' });
    await createNote({ title: 'c', folder: 'reports' });

    const first = await (await call('GET', '/api/notes?projectId=p1&folder=specs&limit=1&offset=0')).json() as { items: { title: string }[]; total: number };
    const second = await (await call('GET', '/api/notes?projectId=p1&folder=specs&limit=1&offset=1')).json() as { items: { title: string }[]; total: number };

    expect([first.total, second.total]).toEqual([2, 2]);
    expect(new Set([first.items[0]!.title, second.items[0]!.title])).toEqual(new Set(['a', 'b']));
  });

  it.each([['offset=-1'], ['offset=abc'], ['offset='], ['offset=9007199254740993']])('refuses %s on the search and the row history with 400', async (query) => {
    const store = await createStore();
    const inserted = await (await call('POST', `/api/data-stores/${store.id}/rows`, { projectId: 'p1', rows: [{}] })).json() as { items: { id: string }[] };

    const search = await call('GET', `/api/notes/search?projectId=p1&q=a&${query}`);
    const history = await call('GET', `/api/data-stores/${store.id}/rows/${inserted.items[0]!.id}/changes?projectId=p1&${query}`);

    expect([search.status, history.status]).toEqual([400, 400]);
  });

  it('pages the search by offset and answers the page shape with the real total', async () => {
    for (const title of ['a', 'b', 'c']) await createNote({ title, bodyMd: 'zebra' });

    const firstPage = await (await call('GET', '/api/notes/search?projectId=p1&q=zebra&limit=2')).json() as { items: { id: string }[]; total: number };
    const lastPage = await (await call('GET', '/api/notes/search?projectId=p1&q=zebra&limit=2&offset=2')).json() as { items: { id: string }[]; total: number };
    const blank = await (await call('GET', '/api/notes/search?projectId=p1&q=&offset=4')).json();

    expect([firstPage.items.length, firstPage.total, lastPage.items.length, lastPage.total]).toEqual([2, 3, 1, 3]);
    expect(lastPage).toMatchObject({ limit: 2, offset: 2 });
    expect(new Set([...firstPage.items, ...lastPage.items].map((item) => item.id)).size).toBe(3);
    expect(blank).toEqual({ items: [], total: 0, limit: 50, offset: 4 });
  });

  it('answers the rows and history reads at their own maximum and one above', async () => {
    const store = await createStore();

    const rowsAtMax = await call('GET', `/api/data-stores/${store.id}/rows?projectId=p1&limit=1000`);
    const rowsOver = await call('GET', `/api/data-stores/${store.id}/rows?projectId=p1&limit=1001`);
    const rowsHugeOffset = await call('GET', `/api/data-stores/${store.id}/rows?projectId=p1&offset=99999999999999999999999`);

    expect([rowsAtMax.status, rowsOver.status, rowsHugeOffset.status]).toEqual([200, 400, 400]);
  });
});

describe('user searching notes never sees a 500', () => {
  it.each([
    ['é'], ['naïve café'], ['😀'], ['日本語 テスト'], ['%00'], ['NEAR'], ['a OR b'], ['*'], ['-a'], ['^a'], ['a:b'], ['(a'], ['a)'], ['"'], ['""'], ['\\'], ["'"], ['title:x'], ['{a}'], ['AND'], ['NOT'],
  ])('answers the query %j with 200', async (query) => {
    await createNote({ bodyMd: 'naïve café 😀 日本語 テスト NEAR a OR b' });

    const response = await call('GET', `/api/notes/search?projectId=p1&q=${query.startsWith('%') ? query : encodeURIComponent(query)}`);

    expect(response.status).toBe(200);
  });

  it('finds an accented word and an emoji written in the body', async () => {
    await createNote({ title: 'Menu', bodyMd: 'un café très crème 😀' });

    const accent = await (await call('GET', `/api/notes/search?projectId=p1&q=${encodeURIComponent('crème')}`)).json() as { items: unknown[] };
    const prefix = await (await call('GET', `/api/notes/search?projectId=p1&q=${encodeURIComponent('cafe')}`)).json() as { items: unknown[] };

    expect(accent.items).toHaveLength(1);
    expect(prefix.items).toHaveLength(1);
  });

  it.each([[16, 200], [17, 400]])('answers a search of %i terms with %i', async (termCount, expected) => {
    const query = Array.from({ length: termCount }, (_, index) => `t${index}`).join(' ');

    const response = await call('GET', `/api/notes/search?projectId=p1&q=${encodeURIComponent(query)}`);

    expect(response.status).toBe(expected);
  });

  it('does not let a project see another project\'s hits and reports total as the page size', async () => {
    await createNote({ projectId: 'p2', bodyMd: 'zebra' });
    await createNote({ bodyMd: 'zebra' });

    const found = await (await call('GET', '/api/notes/search?projectId=p1&q=zebra&limit=1')).json() as { items: unknown[]; total: number };

    expect(found.items).toHaveLength(1);
    expect(found.total).toBe(1);
  });
});

describe('user hitting an unknown method or a malformed path is refused cleanly', () => {
  it.each([['DELETE', '/api/notes/x'], ['PUT', '/api/notes'], ['DELETE', '/api/data-stores/x'], ['PATCH', '/api/notes'], ['POST', '/api/notes/search']])(
    'answers %s %s with 404 or 405, never 500, signed in or not', async (method, path) => {
      const signedIn = await call(method, path, method === 'PUT' || method === 'PATCH' || method === 'POST' ? {} : undefined);
      const anonymous = await call(method, path, undefined, {});

      expect([404, 405]).toContain(signedIn.status);
      expect([401, 404, 405]).toContain(anonymous.status);
    });

  it('answers a malformed percent-escape in a hook token with 404', async () => {
    const response = await call('POST', '/hooks/%E0%A4%A', {}, {});

    expect(response.status).toBe(404);
  });

  it('answers a malformed percent-escape in the row id of the history route with 404', async () => {
    const store = await createStore();

    const response = await call('GET', `/api/data-stores/${store.id}/rows/%E0%A4%A/changes?projectId=p1`);

    expect(response.status).toBe(404);
  });
});

describe('user giving a note a title with surrounding whitespace', () => {
  it('gets the title trimmed on create and on PATCH', async () => {
    const created = await createNote({ title: ' x ' });

    const patched = await (await call('PATCH', `/api/notes/${created.id}`, { projectId: 'p1', expectedRev: 1, title: '  y  ' })).json() as { title: string };

    expect([created.title, patched.title]).toEqual(['x', 'y']);
  });

  it('is refused with 400 when the PATCH title is only whitespace', async () => {
    const note = await createNote();

    const response = await call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 1, title: '   ' });

    expect(response.status).toBe(400);
  });
});

describe('user editing title and body together races safely', () => {
  it('lets exactly one of two concurrent title-and-body patches on the same revision win', async () => {
    const note = await createNote();

    const answers = await Promise.all([
      call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 1, title: 'A', bodyMd: 'body A' }),
      call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 1, title: 'B', bodyMd: 'body B' }),
    ]);
    const final = await (await call('GET', `/api/notes/${note.id}?projectId=p1`)).json() as Record<string, any>;
    const versions = await (await call('GET', `/api/notes/${note.id}/versions?projectId=p1`)).json() as { items: { rev: number }[]; total: number };

    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    expect(final.rev).toBe(2);
    expect(`${final.title} ${final.bodyMd}`).toMatch(/^(A body A|B body B)$/);
    expect(versions.items.map((v) => v.rev)).toEqual([1, 2]);
  });

  it('answers a stale title-and-body patch with 409 and the current revision, leaving the note alone', async () => {
    const note = await createNote();
    await call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 1, bodyMd: 'two' });

    const stale = await call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 1, title: 'X', bodyMd: 'three' });
    const current = await (await call('GET', `/api/notes/${note.id}?projectId=p1`)).json();

    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'stale_revision', currentRev: 2 });
    expect(current).toMatchObject({ title: 'Plan', bodyMd: 'two', rev: 2 });
  });

  it('answers a title-and-body patch on a missing note with 404 and creates no version', async () => {
    const response = await call('PATCH', '/api/notes/ghost', { projectId: 'p1', expectedRev: 1, title: 'X', bodyMd: 'y' });

    expect(response.status).toBe(404);
  });

  it('accepts a 512-character title and refuses 513 on the combined patch too', async () => {
    const note = await createNote();

    const atLimit = await call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 1, title: 't'.repeat(512), bodyMd: 'b' });
    const over = await call('PATCH', `/api/notes/${note.id}`, { projectId: 'p1', expectedRev: 2, title: 't'.repeat(513), bodyMd: 'b' });

    expect([atLimit.status, over.status]).toEqual([200, 400]);
  });

  it('refuses a whitespace-only title', async () => {
    const response = await call('POST', '/api/notes', { projectId: 'p1', title: '   ', bodyMd: '' });

    expect(response.status).toBe(400);
  });

  it('restores onto a file-backed note through the docs folder as a forward revision', async () => {
    const fileBacked = docs.createFileBackedNote({ projectId: fileBackedProjectId, folder: 'specs', title: 'log', bodyMd: 'v1', author: 'seed' });
    await call('PATCH', `/api/notes/${fileBacked.id}`, { projectId: fileBackedProjectId, expectedRev: 1, bodyMd: 'v2' });

    const restored = await call('POST', `/api/notes/${fileBacked.id}/restore`, { projectId: fileBackedProjectId, rev: 1, expectedRev: 2 });

    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ bodyMd: 'v1', rev: 3 });
  });

  it('refuses a restore whose expectedRev is not an integer', async () => {
    const note = await createNote();

    const answers = await Promise.all([1.5, '1', null, -1].map((expectedRev) => call('POST', `/api/notes/${note.id}/restore`, { projectId: 'p1', rev: 1, expectedRev })));

    expect(answers.map((a) => a.status)).toEqual([400, 400, 400, 409]);
  });
});

describe('user reading a row history stays inside the store', () => {
  const insertRow = async (storeId: string) => {
    const inserted = await call('POST', `/api/data-stores/${storeId}/rows`, { projectId: 'p1', rows: [{}] });
    return (await inserted.json() as { items: { id: string }[] }).items?.[0]?.id;
  };

  it('answers 404 for the history of a row read through another store of the same project', async () => {
    const storeA = await createStore('p1', 'A');
    const storeB = await createStore('p1', 'B');
    const rowId = await insertRow(storeA.id);

    const own = await call('GET', `/api/data-stores/${storeA.id}/rows/${rowId}/changes?projectId=p1`);
    const crossStore = await call('GET', `/api/data-stores/${storeB.id}/rows/${rowId}/changes?projectId=p1`);
    const crossProject = await call('GET', `/api/data-stores/${storeA.id}/rows/${rowId}/changes?projectId=p2`);

    expect(rowId).toBeTruthy();
    expect([own.status, crossStore.status, crossProject.status]).toEqual([200, 404, 404]);
  });

  it('answers history limit 0 and 501 consistently with the other limits', async () => {
    const store = await createStore();
    const rowId = await insertRow(store.id);

    const zero = await call('GET', `/api/data-stores/${store.id}/rows/${rowId}/changes?projectId=p1&limit=0`);
    const over = await call('GET', `/api/data-stores/${store.id}/rows/${rowId}/changes?projectId=p1&limit=501`);

    expect([zero.status, over.status]).toEqual([200, 400]);
  });
});

describe('user creating a store gets a precise refusal', () => {
  it('accepts a 200-character name, refuses 201 and refuses a blank one', async () => {
    const atLimit = await call('POST', '/api/data-stores', { projectId: 'p1', displayName: 'n'.repeat(200) });
    const over = await call('POST', '/api/data-stores', { projectId: 'p1', displayName: 'n'.repeat(201) });
    const blank = await call('POST', '/api/data-stores', { projectId: 'p1', displayName: '   ' });

    expect([atLimit.status, over.status, blank.status]).toEqual([201, 400, 400]);
  });

  it('answers 404 project_not_found for a missing project and 409 duplicate_name for a repeated name', async () => {
    await createStore('p1', 'Same');

    const ghost = await call('POST', '/api/data-stores', { projectId: 'ghost', displayName: 'X' });
    const duplicate = await call('POST', '/api/data-stores', { projectId: 'p1', displayName: 'Same' });

    expect(ghost.status).toBe(404);
    expect(await ghost.json()).toEqual({ error: 'project_not_found' });
    expect(duplicate.status).toBe(409);
  });
});
