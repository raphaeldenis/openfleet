import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { startDaemon } from '../daemon.js';
import { startGovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const SEED_PATH = (managerId: string) => `/api/managers/${managerId}/fake-propose-law`;
const SEED_BODY = JSON.stringify({ text: 'Never deploy on Friday', incident: 'Friday outage' });

describe('the end-to-end proposal seeding route', () => {
  const directories = createTempDirTracker();
  afterEach(() => directories.removeAll());

  it('answers 404 like an unknown route when OPENFLEET_E2E is not set', async () => {
    const home = directories.make('governance-no-e2e-');
    const config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0' });
    const daemon = await startDaemon(config, { claudeConfigPath: join(home, 'harness-config.json'), power: { api: { acquire: () => ({ release: () => {} }) } } });
    try {
      const response = await fetch(`${daemon.server.url}${SEED_PATH('any-manager')}`, {
        method: 'POST', body: SEED_BODY, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}` },
      });

      expect(response.status).toBe(404);
    } finally {
      await daemon.close();
      daemon.db.close();
    }
  });

  it('files a pending law through the real queue when OPENFLEET_E2E is set, and never decides it', async () => {
    const fixture = await startGovernanceFixture();
    try {
      const response = await fixture.api(SEED_PATH(fixture.lead.id), { method: 'POST', body: SEED_BODY });

      expect(response.status).toBe(200);
      const pending = (await (await fixture.api('/api/governance/proposals')).json()) as { managerId: string; status: string; payload: { text: string } }[];
      expect(pending.map(({ managerId, status, payload }) => ({ managerId, status, text: payload.text }))).toEqual([
        { managerId: fixture.lead.id, status: 'pending', text: 'Never deploy on Friday' },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it('is refused without the admin token', async () => {
    const fixture = await startGovernanceFixture();
    try {
      const response = await fetch(`${fixture.daemon.server.url}${SEED_PATH(fixture.lead.id)}`, { method: 'POST', body: SEED_BODY, headers: { 'content-type': 'application/json' } });

      expect(response.status).toBe(401);
    } finally {
      await fixture.close();
    }
  });
});
