import { MANAGER_ROLE } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { SessionService } from './sessionService.js';

const serviceOptions = { baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' };
const aSessionSpec = { directory: '/tmp', harness: 'fake', emoji: '⚔️' } as const;

function aSessionService() {
  const db = openDatabase(':memory:');
  const sessions = new SessionService({ db, bus: new EventBus(), harnesses: [new FakeHarness()], ...serviceOptions });
  const attendedColumnOf = (sessionId: string) => (db.prepare('SELECT attended FROM sessions WHERE id = ?').get(sessionId) as { attended: number }).attended;
  return { sessions, attendedColumnOf };
}

describe('SessionService.create and the attended flag', () => {
  it('stores an attended parentless manager as attended', async () => {
    const { sessions, attendedColumnOf } = aSessionService();

    const lead = await sessions.create({ ...aSessionSpec, name: 'Lead', role: MANAGER_ROLE, attended: true });

    expect(lead.attended).toBe(true);
    expect(attendedColumnOf(lead.id)).toBe(1);
  });

  it('never stores a manager that has a parent as attended, whatever it asks for', async () => {
    const { sessions, attendedColumnOf } = aSessionService();
    const parent = await sessions.create({ ...aSessionSpec, name: 'Lead', role: MANAGER_ROLE, attended: true });

    const subLead = await sessions.create({ ...aSessionSpec, name: 'SubLead', role: MANAGER_ROLE, parentId: parent.id, attended: true });

    expect(subLead.attended).toBeUndefined();
    expect(attendedColumnOf(subLead.id)).toBe(0);
  });

  it('never stores a session that is not a manager as attended, whatever it asks for', async () => {
    const { sessions, attendedColumnOf } = aSessionService();

    const worker = await sessions.create({ ...aSessionSpec, name: 'Worker', role: 'DEV', attended: true });

    expect(worker.attended).toBeUndefined();
    expect(attendedColumnOf(worker.id)).toBe(0);
  });
});
