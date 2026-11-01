import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { startDaemon } from '../daemon.js';
import { startGovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { ActivityRepository } from './activityRepository.js';

const rowsNamed = (db: ConstructorParameters<typeof ActivityRepository>[0], action: string) => new ActivityRepository(db).list({ limit: 50, action }).items;

describe('the actions of the daemon itself, booted with its own wiring', () => {
  it('records its start as a system row', async () => {
    const fixture = await startGovernanceFixture();

    const rows = rowsNamed(fixture.db, 'daemon.start');
    await fixture.close();

    expect(rows).toEqual([expect.objectContaining({ actorKind: 'system', actorLabel: 'daemon', source: 'daemon', outcome: 'ok' })]);
    expect(rows[0]?.detail).toMatch(/^version /);
  });

  it('records a pulse sent to a manager as a system row of the scheduler, filed under that manager', async () => {
    const fixture = await startGovernanceFixture();

    const response = await fixture.api(`/api/managers/${fixture.lead.id}/pulse`, { method: 'POST' });

    const rows = rowsNamed(fixture.db, 'pulse.sent');
    await fixture.close();
    expect(response.status).toBe(200);
    expect(rows).toEqual([expect.objectContaining({
      actorKind: 'system', actorLabel: 'scheduler', source: 'daemon', sessionId: fixture.lead.id, managerId: fixture.lead.id, outcome: 'ok',
    })]);
  });

  it('lets the pulse go through when the log cannot be written', async () => {
    const fixture = await startGovernanceFixture();
    fixture.db.exec('DROP TABLE activity_log');

    const response = await fixture.api(`/api/managers/${fixture.lead.id}/pulse`, { method: 'POST' });

    await fixture.close();
    expect(response.status).toBe(200);
  });
});

describe('the sessions a restart brings back', () => {
  const directories = createTempDirTracker();
  afterEach(() => { directories.removeAll(); });

  it('records each resumed session as a system row of the daemon, and none on a first boot', async () => {
    const home = directories.make('activity-resume-');
    const config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', OPENFLEET_E2E: '1' });
    const options = { claudeConfigPath: join(home, 'harness-config.json'), power: { api: { acquire: () => ({ release: () => {} }) } } };
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}` };
    const firstRun = await startDaemon(config, options);
    const directory = join(home, 'worker');
    mkdirSync(directory);
    const created = await fetch(`${firstRun.server.url}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ directory, name: 'Worker', harness: 'fake', emoji: '🤖' }) });
    const { id } = await created.json() as { id: string };
    const resumedOnFirstBoot = rowsNamed(firstRun.db, 'session.resume');
    await firstRun.close();

    const secondRun = await startDaemon(config, options);
    const resumedOnSecondBoot = rowsNamed(secondRun.db, 'session.resume');
    await secondRun.close();

    expect(resumedOnFirstBoot).toEqual([]);
    expect(resumedOnSecondBoot).toEqual([expect.objectContaining({
      actorKind: 'system', actorLabel: 'daemon', source: 'daemon', sessionId: id, entityKind: 'session', entityId: id, entityLabel: 'Worker', outcome: 'ok',
    })]);
  });
});
