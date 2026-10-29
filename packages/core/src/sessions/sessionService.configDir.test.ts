import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { SessionService } from './sessionService.js';

const syntheticProfile = '/Users/synthetic/.claude-work';
const serviceOptions = { baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' };

describe('SessionService with a config dir', () => {
  it('launches the session with the config dir and shows only the profile name on the session', async () => {
    const harness = new FakeHarness();
    const sessions = new SessionService({ db: openDatabase(':memory:'), bus: new EventBus(), harnesses: [harness], ...serviceOptions });

    const session = await sessions.create({ directory: '/tmp', name: 'Gimli', harness: 'fake', emoji: '⚔️', configDir: syntheticProfile });

    expect(harness.launches[0]!.configDir).toBe(syntheticProfile);
    expect(session.configProfile).toBe('.claude-work');
    expect(JSON.stringify(session)).not.toContain('/Users/synthetic');
    expect(JSON.stringify(sessions.get(session.id))).not.toContain('/Users/synthetic');
  });

  it('relaunches the session with the same config dir after a daemon restart', async () => {
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const original = new SessionService({ db, bus, harnesses: [new FakeHarness()], ...serviceOptions });
    const session = await original.create({ directory: '/tmp', name: 'Gimli', harness: 'fake', emoji: '⚔️', configDir: syntheticProfile });
    const restartHarness = new FakeHarness();
    const restarted = new SessionService({ db, bus, harnesses: [restartHarness], ...serviceOptions, resumeTimeoutMs: 50 });

    await restarted.resumeAll();

    expect(restartHarness.launches[0]!.resuming).toBe(true);
    expect(restartHarness.launches[0]!.configDir).toBe(syntheticProfile);
    expect(restarted.get(session.id)!.configProfile).toBe('.claude-work');
  });

  it('launches a session without a config dir exactly as before', async () => {
    const harness = new FakeHarness();
    const sessions = new SessionService({ db: openDatabase(':memory:'), bus: new EventBus(), harnesses: [harness], ...serviceOptions });

    const session = await sessions.create({ directory: '/tmp', name: 'Gimli', harness: 'fake', emoji: '⚔️' });

    expect(harness.launches[0]!.configDir).toBeUndefined();
    expect(session.configProfile).toBeUndefined();
  });
});
