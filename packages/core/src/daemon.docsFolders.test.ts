import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_FLAG_ENV, E2E_FLAG_ON, type Project } from '@openfleet/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from './config.js';
import { startDaemon, type Daemon } from './daemon.js';
import { openDatabase } from './db/database.js';
import { nodeDocsFolderFs } from './notes/nodeDocsFolderFs.js';
import { ProjectRepository } from './projects/projectRepository.js';
import { createTempDirTracker } from './tempDirTracker.js';

const tempDirs = createTempDirTracker();
const PROJECT_ID = '3f2b8c1e-5d4a-4b6e-9a7c-1d2e3f4a5b6c';
const NOTE_FILE = '2026-10-01-design.md';
let daemon: Daemon | undefined;
let config: Config;

afterEach(async () => {
  vi.restoreAllMocks();
  await daemon?.close();
  daemon = undefined;
  tempDirs.removeAll();
});

/** Boots a daemon on a fresh home; `seed` runs against that home's database before the daemon opens it. */
async function bootDaemon(seed: (projects: ProjectRepository) => void = () => {}): Promise<Daemon> {
  const home = tempDirs.make('of-daemon-docs-');
  config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  const seedDb = openDatabase(config.dbPath);
  seed(new ProjectRepository(seedDb));
  seedDb.close();
  daemon = await startDaemon(config);
  return daemon;
}

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon!.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...(init.headers ?? {}) } });
const noteTitles = () => (daemon!.db.prepare('SELECT title FROM notes ORDER BY title').all() as { title: string }[]).map((row) => row.title);
const noteBody = (title: string) => (daemon!.db.prepare('SELECT body_md FROM notes WHERE title = ?').get(title) as { body_md: string } | undefined)?.body_md;

function aDocsFolderWithANote(): string {
  const folder = tempDirs.make('of-daemon-docs-folder-');
  mkdirSync(join(folder, 'specs'));
  writeFileSync(join(folder, 'specs', NOTE_FILE), '# Design v1');
  return folder;
}

describe('the daemon keeps the docs folders of its projects in step with their notes', () => {
  it('imports the note files already in a project docs folder when it boots', async () => {
    const folder = aDocsFolderWithANote();

    await bootDaemon((projects) => projects.insert({ id: PROJECT_ID, name: 'Fleet', docsFolderPath: folder, createdAt: 't0' }));

    expect(noteTitles()).toEqual(['design']);
    expect(noteBody('design')).toBe('# Design v1');
  });

  it('applies an edit made on disk after boot to the note', async () => {
    const folder = aDocsFolderWithANote();
    await bootDaemon((projects) => projects.insert({ id: PROJECT_ID, name: 'Fleet', docsFolderPath: folder, createdAt: 't0' }));

    writeFileSync(join(folder, 'specs', NOTE_FILE), '# Design v2');

    await vi.waitFor(() => expect(noteBody('design')).toBe('# Design v2'), { timeout: 5000, interval: 50 });
  });

  it('boots without crashing when a project docs folder is gone, and says so without naming the path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const folder = join(tempDirs.make('of-daemon-docs-gone-'), 'deleted-docs');

    await bootDaemon((projects) => projects.insert({ id: PROJECT_ID, name: 'Fleet', docsFolderPath: folder, createdAt: 't0' }));

    const health = await fetch(`${daemon!.server.url}/health`);
    expect(health.status).toBe(200);
    const warnings = warn.mock.calls.map((call) => String(call[0]));
    expect(warnings.some((line) => line.includes('docs folder') && line.includes(PROJECT_ID))).toBe(true);
    expect(warnings.some((line) => line.includes(folder))).toBe(false);
  });

  it('boots with a project that has no docs folder', async () => {
    await bootDaemon((projects) => projects.insert({ id: PROJECT_ID, name: 'Fleet', docsFolderPath: null, createdAt: 't0' }));

    expect((await fetch(`${daemon!.server.url}/health`)).status).toBe(200);
  });

  it('watches the folder of a project created through the API and imports its notes', async () => {
    await bootDaemon();
    const folder = aDocsFolderWithANote();

    const created = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Fleet', docsFolderPath: folder }) });
    const project = (await created.json()) as Project;
    expect(created.status).toBe(201);
    expect(noteTitles()).toEqual(['design']);
    writeFileSync(join(folder, 'specs', NOTE_FILE), '# Design v2');

    await vi.waitFor(() => expect(noteBody('design')).toBe('# Design v2'), { timeout: 5000, interval: 50 });
    expect(project.docsFolderPath).toBe(folder);
  });

  it('watches the new folder when PATCH sets the docs folder of an existing project', async () => {
    await bootDaemon((projects) => projects.insert({ id: PROJECT_ID, name: 'Fleet', docsFolderPath: null, createdAt: 't0' }));
    const folder = aDocsFolderWithANote();

    const patched = await api(`/api/projects/${PROJECT_ID}`, { method: 'PATCH', body: JSON.stringify({ docsFolderPath: folder }) });

    expect(patched.status).toBe(200);
    expect(noteTitles()).toEqual(['design']);
    writeFileSync(join(folder, 'specs', NOTE_FILE), '# Design v3');
    await vi.waitFor(() => expect(noteBody('design')).toBe('# Design v3'), { timeout: 5000, interval: 50 });
  });

  it('stops every folder watcher when the daemon closes', async () => {
    const unsubscribes: ReturnType<typeof vi.fn>[] = [];
    const realWatch = nodeDocsFolderFs.watch.bind(nodeDocsFolderFs);
    vi.spyOn(nodeDocsFolderFs, 'watch').mockImplementation((dirPath, onEvent) => {
      const stopWatching = realWatch(dirPath, onEvent);
      const unsubscribe = vi.fn(stopWatching);
      unsubscribes.push(unsubscribe);
      return unsubscribe;
    });
    const folder = aDocsFolderWithANote();
    await bootDaemon((projects) => projects.insert({ id: PROJECT_ID, name: 'Fleet', docsFolderPath: folder, createdAt: 't0' }));
    expect(unsubscribes).toHaveLength(1);

    await daemon!.close();
    daemon = undefined;

    expect(unsubscribes[0]).toHaveBeenCalledOnce();
  });
});
