import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_FLAG_ENV, E2E_FLAG_ON, type CommandPolicyView } from '@openfleet/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from './config.js';
import { startDaemon, type Daemon } from './daemon.js';
import { createTempDirTracker } from './tempDirTracker.js';

const tempDirs = createTempDirTracker();
let daemon: Daemon | undefined;
let config: Config;

async function bootDaemon(home = tempDirs.make('of-policy-handedit-')): Promise<void> {
  config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  daemon = await startDaemon(config);
}
afterEach(async () => { vi.restoreAllMocks(); await daemon?.close(); daemon = undefined; tempDirs.removeAll(); });

const call = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon!.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}` } });
const getPolicy = async () => (await (await call('/api/command-policy')).json()) as CommandPolicyView;
const putPolicy = (document: unknown) => call('/api/command-policy', { method: 'PUT', body: JSON.stringify(document) });
const policyFilePath = () => join(config.home, 'command-policy.json');

describe('a hand-edited command-policy.json with one invalid part', () => {
  const goodRule = { id: 'no-pnpm-install', tools: ['Bash'], decision: 'deny', when: { program: 'pnpm' }, reason: 'Installs change the lockfile.', alternative: 'Ask your manager.' };
  const tooLongRule = { id: 'no-yarn', tools: ['Bash'], decision: 'deny', when: { program: 'yarn' }, reason: 'x'.repeat(400), alternative: 'Ask your manager.' };
  const handEditedText = JSON.stringify({ version: 1, mode: 'enforce', rules: [goodRule, tooLongRule], profiles: { default: { rules: ['no-pnpm-install'] } } }, null, 2);
  const backupNames = () => readdirSync(config.home).filter((name) => name.startsWith('command-policy.json.bak-'));

  async function bootOnHandEditedFile(): Promise<void> {
    const home = tempDirs.make('of-policy-handedit-');
    writeFileSync(join(home, 'command-policy.json'), handEditedText);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await bootDaemon(home);
  }

  it('serves only the valid parts as the override and lists the ignored part in issues', async () => {
    await bootOnHandEditedFile();

    const view = await getPolicy();

    expect(view.override).toEqual({ version: 1, mode: 'enforce', rules: [goodRule], profiles: { default: { rules: ['no-pnpm-install'] } } });
    expect(view.issues).toEqual([expect.stringContaining('rule no-yarn')]);
  });

  it('accepts a save of what the view gave back and keeps the original file under a .bak name', async () => {
    await bootOnHandEditedFile();
    const view = await getPolicy();

    const response = await putPolicy({ ...view.override, mode: 'observe' });

    expect(response.status).toBe(200);
    const saved = (await response.json()) as CommandPolicyView;
    expect(saved).toMatchObject({ mode: 'observe', issues: [] });
    expect(saved.previousFileKeptAs).toMatch(/^command-policy\.json\.bak-/);
    expect(backupNames()).toEqual([saved.previousFileKeptAs]);
    expect(readFileSync(join(config.home, saved.previousFileKeptAs!), 'utf8')).toBe(handEditedText);
    expect(JSON.parse(readFileSync(policyFilePath(), 'utf8'))).toMatchObject({ mode: 'observe', rules: [goodRule] });
    expect((await getPolicy()).issues).toEqual([]);
  });

  it('keeps a file the daemon wrote itself without any backup', async () => {
    await bootDaemon();
    await putPolicy({ version: 1, mode: 'observe' });

    const response = await putPolicy({ version: 1, mode: 'enforce' });

    expect(((await response.json()) as CommandPolicyView).previousFileKeptAs).toBeUndefined();
    expect(backupNames()).toEqual([]);
  });

  it('keeps a valid hand edit made after the daemon started', async () => {
    await bootDaemon();
    await putPolicy({ version: 1, mode: 'observe' });
    writeFileSync(policyFilePath(), JSON.stringify({ version: 1, mode: 'off' }));

    const saved = (await (await putPolicy({ version: 1, mode: 'enforce' })).json()) as CommandPolicyView;

    expect(readFileSync(join(config.home, saved.previousFileKeptAs!), 'utf8')).toBe('{"version":1,"mode":"off"}');
  });
});
