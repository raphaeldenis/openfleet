import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_FLAG_ENV, E2E_FLAG_ON, type DocsRootView } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from './config.js';
import { startDaemon, type Daemon } from './daemon.js';
import { createTempDirTracker } from './tempDirTracker.js';

const tempDirs = createTempDirTracker();
const DOCS_ROOT_URL = '/api/settings/docs-root';
let daemon: Daemon | undefined;
let config: Config;
let userHome: string;

beforeEach(() => {
  userHome = tempDirs.make('of-docs-root-user-home-');
  vi.stubEnv('HOME', userHome);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await daemon?.close();
  daemon = undefined;
  tempDirs.removeAll();
});

async function bootDaemon(): Promise<void> {
  config ??= loadConfig({ OPENFLEET_HOME: tempDirs.make('of-docs-root-daemon-home-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  daemon = await startDaemon(config);
}

async function restartDaemon(): Promise<void> {
  await daemon?.close();
  daemon = undefined;
  await bootDaemon();
}

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon!.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...(init.headers ?? {}) } });
const saveRoot = (root: unknown) => api(DOCS_ROOT_URL, { method: 'PATCH', body: JSON.stringify({ root }) });
const readRoot = async (query = '') => (await (await api(`${DOCS_ROOT_URL}${query}`)).json()) as DocsRootView;

describe('the docs root setting of a booted daemon', () => {
  beforeEach(async () => {
    config = undefined as unknown as Config;
    await bootDaemon();
  });

  it('answers the default root under the home folder when nothing is saved', async () => {
    expect(await readRoot()).toEqual({ root: join(userHome, 'Documents', 'OpenFleet'), isDefault: true });
  });

  it('proposes <root>/<project name> for a project name, with separators neutralized', async () => {
    const view = await readRoot(`?projectName=${encodeURIComponent('My App/../x')}`);

    expect(view.proposedPath).toBe(join(userHome, 'Documents', 'OpenFleet', 'My App-..-x'));
  });

  it('saves a valid root, creates it, reads it back and keeps it after a restart', async () => {
    const wantedRoot = join(userHome, 'Work', 'docs');

    const response = await saveRoot(wantedRoot);

    expect(response.status).toBe(200);
    expect(existsSync(wantedRoot)).toBe(true);
    const afterSave = await readRoot('?projectName=Fleet');
    expect(afterSave.isDefault).toBe(false);
    expect(afterSave.root.endsWith(join('Work', 'docs'))).toBe(true);
    expect(afterSave.proposedPath).toBe(join(afterSave.root, 'Fleet'));
    await restartDaemon();
    expect((await readRoot()).root).toBe(afterSave.root);
  });

  it('refuses a relative path with a clear message and saves nothing', async () => {
    const response = await saveRoot('Documents/docs');

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'docs_root_invalid', message: expect.stringContaining('absolute path') });
    expect((await readRoot()).isDefault).toBe(true);
  });

  it.each([['an empty value', '   '], ['a value with a NUL character', '/x\u0000y']])('refuses %s', async (_label, typedRoot) => {
    const response = await saveRoot(typedRoot);

    expect((await response.json()).error).toBe('docs_root_invalid');
  });

  it('refuses a body that is not a string root as an invalid body', async () => {
    const response = await saveRoot(42);

    expect((await response.json()).error).toBe('invalid_body');
  });

  it('refuses a folder outside the home folder without creating it', async () => {
    const outsideHome = join(tempDirs.make('of-docs-root-outside-'), 'docs');

    const response = await saveRoot(outsideHome);

    expect((await response.json()).error).toBe('docs_root_invalid');
    expect(existsSync(outsideHome)).toBe(false);
  });

  it('refuses a path that is a file', async () => {
    const filePath = join(userHome, 'notes.txt');
    writeFileSync(filePath, 'x');

    expect((await (await saveRoot(filePath)).json()).error).toBe('docs_root_invalid');
  });

  it('refuses a symlink inside the home folder that leads outside it', async () => {
    const outside = tempDirs.make('of-docs-root-outside-');
    symlinkSync(outside, join(userHome, 'escape'));

    const response = await saveRoot(join(userHome, 'escape', 'docs'));

    expect((await response.json()).error).toBe('docs_root_invalid');
    expect(existsSync(join(outside, 'docs'))).toBe(false);
  });

  it.each(['.claude', '.scape', '.openfleet', '.openfleet-dev'])('refuses ~/%s and anything below it, creating nothing', async (reservedFolder) => {
    const reservedPath = join(userHome, reservedFolder);
    mkdirSync(reservedPath);

    const atTheFolder = await saveRoot(reservedPath);
    const belowTheFolder = await saveRoot(join(reservedPath, 'docs'));

    expect((await atTheFolder.json()).error).toBe('docs_root_forbidden');
    expect((await belowTheFolder.json()).error).toBe('docs_root_forbidden');
    expect(existsSync(join(reservedPath, 'docs'))).toBe(false);
  });

  const isCaseInsensitiveFileSystem = process.platform === 'darwin';

  it.skipIf(!isCaseInsensitiveFileSystem).each([
    ['.CLAUDE', ['.CLAUDE', 'sub']],
    ['.Claude', ['.Claude']],
    ['.OPENFLEET', ['.OPENFLEET', 'y']],
    ['.OPENFLEET-DEV', ['.OPENFLEET-DEV', 'y']],
    ['.SCAPE with a missing sub folder', ['.SCAPE', 'missing', 'deeper']],
  ])('refuses %s whatever the letter case, creating nothing', async (_label, segments) => {
    const keptFolders = ['.claude', '.scape', '.openfleet', '.openfleet-dev'];
    keptFolders.forEach((folder) => mkdirSync(join(userHome, folder)));

    const response = await saveRoot(join(userHome, ...segments));

    expect((await response.json()).error).toBe('docs_root_forbidden');
    expect(readdirSync(join(userHome, '.claude'))).toEqual([]);
    expect(readdirSync(join(userHome, '.scape'))).toEqual([]);
    expect(readdirSync(join(userHome, '.openfleet'))).toEqual([]);
    expect((await readRoot()).isDefault).toBe(true);
  });

  it.skipIf(!isCaseInsensitiveFileSystem)('refuses a differently cased reserved folder that does not exist yet',async () => {
    const response = await saveRoot(join(userHome, '.CLAUDE', 'sub'));

    expect((await response.json()).error).toBe('docs_root_forbidden');
    expect(readdirSync(userHome)).toEqual([]);
  });

  it.each([
    ['a parent segment', ['Documents', 'qa-docs', '..', 'x']],
    ['a current-folder segment', ['Documents', '.', 'x']],
  ])('refuses a root with %s instead of normalizing it, creating nothing', async (_label, segments) => {
    const typedRoot = [userHome, ...segments].join('/');

    const response = await saveRoot(typedRoot);

    expect((await response.json()).error).toBe('docs_root_invalid');
    expect(existsSync(join(userHome, 'Documents'))).toBe(false);
    expect((await readRoot()).isDefault).toBe(true);
  });

  it('refuses the home folder itself', async () => {
    const response = await saveRoot(userHome);

    expect((await response.json()).error).toBe('docs_root_forbidden');
    expect((await readRoot()).isDefault).toBe(true);
  });

  it('accepts a valid folder under Documents/OpenFleet', async () => {
    const response = await saveRoot(join(userHome, 'Documents', 'OpenFleet'));

    expect(response.status).toBe(200);
    expect((await readRoot()).isDefault).toBe(false);
  });

  it('falls back to the default when the saved root is a reserved folder by the time it is read', async () => {
    writeFileSync(join(config.home, 'config.json'), JSON.stringify({ docs: { root: join(userHome, '.claude', 'docs') } }));

    expect(await readRoot()).toEqual({ root: join(userHome, 'Documents', 'OpenFleet'), isDefault: true });
  });

  it('refuses a reserved folder that does not exist yet', async () => {
    const response = await saveRoot(join(userHome, '.scape', 'docs'));

    expect((await response.json()).error).toBe('docs_root_forbidden');
    expect(existsSync(join(userHome, '.scape'))).toBe(false);
  });

  it('refuses a symlink in the home folder that points to a reserved folder', async () => {
    mkdirSync(join(userHome, '.claude'));
    symlinkSync(join(userHome, '.claude'), join(userHome, 'shortcut'));

    const response = await saveRoot(join(userHome, 'shortcut'));

    expect((await response.json()).error).toBe('docs_root_forbidden');
  });

  it('refuses the daemon home folder', async () => {
    const response = await saveRoot(config.home);

    expect((await response.json()).error).toBe('docs_root_forbidden');
  });

  it('refuses a read-only folder as not writable', async () => {
    const readOnlyFolder = join(userHome, 'readonly');
    mkdirSync(readOnlyFolder);
    chmodSync(readOnlyFolder, 0o500);

    const response = await saveRoot(readOnlyFolder);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('docs_root_not_writable');
  });

  it('never repeats the typed path in an error message', async () => {
    const typedRoot = join(userHome, '.claude', 'secret-folder-name');
    mkdirSync(join(userHome, '.claude'));

    const body = JSON.stringify(await (await saveRoot(typedRoot)).json());

    expect(body).not.toContain('secret-folder-name');
    expect(body).not.toContain(userHome);
  });
});
