import { ActivityPageSchema, type ActivityPage } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityRepository } from '../activity/activityRepository.js';
import { startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';

let fixture: GovernanceFixture;
const SEEDED_AT = '2020-01-01T00:00:00.000Z';
const BETWEEN_SEEDED_AND_NOW = '2021-01-01T00:00:00.000Z';

// The fixture creates its sessions through the REST API, which the log records; each test starts from an empty log.
beforeEach(async () => {
  fixture = await startGovernanceFixture();
  fixture.db.exec('DELETE FROM activity_log');
});
afterEach(async () => { await fixture.close(); });

const activityPage = async (query = ''): Promise<ActivityPage> => {
  const response = await fixture.api(`/api/activity${query}`);
  if (response.status !== 200) throw new Error(`GET /api/activity${query} answered ${response.status}`);
  return ActivityPageSchema.parse(await response.json());
};

const actionsOf = (page: ActivityPage) => page.items.map((row) => row.action);

const seed = (rows: { managerId?: string; action: string }[]) => {
  const repository = new ActivityRepository(fixture.db);
  for (const { managerId, action } of rows) {
    repository.insert({ at: SEEDED_AT, actorKind: 'agent', actorLabel: 'Seed', source: 'mcp', action, outcome: 'ok', ...(managerId === undefined ? {} : { managerId }) });
  }
};

describe('GET /api/activity', () => {
  it('answers 401 without a token, with a wrong token and with the MCP token of a session', async () => {
    const mcpToken = (fixture.db.prepare('SELECT mcp_token FROM sessions WHERE id = ?').get(fixture.lead.id) as { mcp_token: string }).mcp_token;
    const withBearer = (token: string) => fetch(`${fixture.daemon.server.url}/api/activity`, { headers: { authorization: `Bearer ${token}` } });

    const statuses = [
      (await fetch(`${fixture.daemon.server.url}/api/activity`)).status,
      (await withBearer('not-the-admin-token')).status,
      (await withBearer(mcpToken)).status,
    ];

    expect(statuses).toEqual([401, 401, 401]);
  });

  it('leaves no trace of a refused request in the log', async () => {
    await fetch(`${fixture.daemon.server.url}/api/activity`, { method: 'POST' });
    await fetch(`${fixture.daemon.server.url}/api/data-stores`, { method: 'POST', body: '{}' });

    expect(await activityPage()).toEqual({ items: [] });
  });

  it('returns the newest first and pages with the cursor', async () => {
    seed([{ action: 'a1' }, { action: 'a2' }, { action: 'a3' }]);

    const first = await activityPage('?limit=2');
    const second = await activityPage(`?limit=2&cursor=${first.nextCursor}`);

    expect([...actionsOf(first), ...actionsOf(second)]).toEqual(['a3', 'a2', 'a1']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('filters by actor, session, entity, action, outcome and time range', async () => {
    seed([{ action: 'a1' }]);
    await fixture.createTable('project-own', 'Table');

    expect(actionsOf(await activityPage('?actor=human'))).toEqual(['POST /api/data-stores']);
    expect(actionsOf(await activityPage('?actor=agent'))).toEqual(['a1']);
    expect(actionsOf(await activityPage('?action=a1&outcome=ok'))).toEqual(['a1']);
    expect(actionsOf(await activityPage(`?until=${BETWEEN_SEEDED_AND_NOW}`))).toEqual(['a1']);
    expect(actionsOf(await activityPage(`?since=${BETWEEN_SEEDED_AND_NOW}`))).toEqual(['POST /api/data-stores']);
  });

  it('returns the rows of the manager asked for and never those of another lineage', async () => {
    seed([{ managerId: 'manager-a', action: 'of_a' }, { managerId: 'manager-b', action: 'of_b' }]);

    expect(actionsOf(await activityPage('?manager=manager-a'))).toEqual(['of_a']);
  });

  it.each(['?limit=0', '?limit=201', '?limit=abc', '?cursor=not-a-number', '?actor=robot', '?outcome=gated', '?since=yesterday'])(
    'refuses %s with a 400',
    async (query) => {
      const response = await fixture.api(`/api/activity${query}`);

      expect(response.status).toBe(400);
    },
  );
});

describe('the human actions recorded from the REST calls', () => {
  it('records a mutating call with the admin token as a human row', async () => {
    await fixture.createTable('project-own', 'Table');

    expect((await activityPage()).items).toEqual([expect.objectContaining({
      actorKind: 'human', actorLabel: 'admin', source: 'rest', action: 'POST /api/data-stores', outcome: 'ok',
    })]);
  });

  it('records a refused decision under its semantic name with the entity it targets', async () => {
    const response = await fixture.api('/api/governance/proposals/no-such-proposal/decide', { method: 'POST', body: JSON.stringify({ decision: 'approve' }) });

    expect(response.status).toBe(404);
    expect((await activityPage()).items[0]).toMatchObject({ action: 'proposal.decide', entityKind: 'proposal', entityId: 'no-such-proposal', outcome: 'error' });
  });

  it('records no row for a read', async () => {
    await fixture.api('/api/sessions');
    await fixture.api('/api/notes');

    expect(await activityPage()).toEqual({ items: [] });
  });

  it('lets the call succeed when the log cannot be written', async () => {
    fixture.db.exec('DROP TABLE activity_log');

    const response = await fixture.api('/api/data-stores', { method: 'POST', body: JSON.stringify({ projectId: 'project-own', displayName: 'Still works' }) });

    expect(response.status).toBe(201);
  });
});
