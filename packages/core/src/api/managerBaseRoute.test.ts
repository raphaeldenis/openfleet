import { readFileSync } from 'node:fs';
import { E2E_FLAG_ENV, E2E_FLAG_ON, MANAGER_BASE_PATH, type ManagerBaseView } from '@openfleet/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const SHIPPED_SHA_URL = new URL('../../templates/manager/base.sha256', import.meta.url);
const MAX_BASE_BYTES = 8192;

const tempDirs = createTempDirTracker();
let daemon: Daemon;
let config: Config;

beforeAll(async () => {
  config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-base-route-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  daemon = await startDaemon(config);
});
afterAll(async () => {
  await daemon.close();
  tempDirs.removeAll();
});

const getBase = (headers: Record<string, string> = { authorization: `Bearer ${config.adminToken}` }) => fetch(`${daemon.server.url}${MANAGER_BASE_PATH}`, { headers });

describe('GET /api/manager-base on a booted daemon', () => {
  it('answers the version, the sha, the size and the ten sections of the shipped base', async () => {
    const response = await getBase();
    const view = (await response.json()) as ManagerBaseView;

    expect(response.status).toBe(200);
    expect(view.version).toBe(2);
    expect(view.sha).toBe(readFileSync(SHIPPED_SHA_URL, 'utf8').trim());
    expect(view.bytes).toBeGreaterThan(0);
    expect(view.bytes).toBeLessThanOrEqual(MAX_BASE_BYTES);
    expect(view.sections).toHaveLength(10);
    expect(view.sections[0]).toEqual({ id: '§1', title: 'Precedence', bytes: expect.any(Number) });
    expect(view.sections.reduce((total, section) => total + section.bytes, 0)).toBeLessThanOrEqual(view.bytes);
  });

  it('does not carry the text of the base', async () => {
    const view = await (await getBase()).json();

    expect(Object.keys(view).sort()).toEqual(['bytes', 'sections', 'sha', 'version']);
  });

  it('refuses a request without the admin token', async () => {
    expect((await getBase({})).status).toBe(401);
  });

  it('refuses a wrong admin token', async () => {
    expect((await getBase({ authorization: 'Bearer nope' })).status).toBe(401);
  });
});
