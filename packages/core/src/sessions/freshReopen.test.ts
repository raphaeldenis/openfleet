import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MANAGER_ROLE } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { MessageQueue } from './messageQueue.js';
import { SessionRepository } from './sessionRepository.js';
import { SessionService } from './sessionService.js';

const BRIEF = 'Fix the flaky login test, then report to your manager.';
const PULSE_LINE = '[pulse] Re-read your mission and continue: check your children, unblock them, record what you did.';
const AGENT_MESSAGE = 'Please also look at the CI cache.';
const NOTICE_WITH_PROMPT = 'Started a new conversation. The previous one was not resumed.';
const NOTICE_WITHOUT_PROMPT = 'Started a new conversation with no starting prompt: none is stored for this session.';

let db: DatabaseSync;
let harness: FakeHarness;
let sessions: SessionService;
let directory: string;

const serviceOn = (database: DatabaseSync, fakeHarness: FakeHarness) =>
  new SessionService({
    db: database, bus: new EventBus(), harnesses: [fakeHarness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: join(directory, 'worktrees'),
    missionOf: (sessionId) => new ManagerRepository(database).get(sessionId)?.missionText,
  });

const lastLaunch = () => harness.launches.at(-1)!;
const spawnChild = async ({ brief, parentId }: { brief?: string; parentId?: string } = {}) =>
  sessions.create({ directory, name: 'child', emoji: '🧒', harness: 'fake', seededPrompt: brief, parentId });
const closeThenReopenFresh = async (sessionId: string) => {
  await sessions.close(sessionId);
  return sessions.reopen(sessionId, { mode: 'fresh' });
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'of-fresh-any-'));
  db = openDatabase(':memory:');
  harness = new FakeHarness();
  sessions = serviceOn(db, harness);
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('reopening a closed child fresh', () => {
  it('starts a new conversation seeded with the brief it was created with', async () => {
    const child = await spawnChild({ brief: BRIEF });
    const conversationBefore = new SessionRepository(db).cliSessionId(child.id) ?? child.id;

    await closeThenReopenFresh(child.id);

    expect(lastLaunch().resuming).toBe(false);
    expect(lastLaunch().seededPrompt).toBe(BRIEF);
    expect(lastLaunch().cliSessionId).not.toBe(conversationBefore);
    expect(lastLaunch().sessionId).toBe(child.id);
  });

  it('still has the brief after a daemon restart', async () => {
    const child = await spawnChild({ brief: BRIEF });
    await sessions.close(child.id);
    const restartedHarness = new FakeHarness();
    harness = restartedHarness;
    const restarted = serviceOn(db, restartedHarness);

    restarted.reopen(child.id, { mode: 'fresh' });

    expect(restartedHarness.launches.at(-1)!.seededPrompt).toBe(BRIEF);
  });

  it('starts with no prompt and says so when the session has no stored brief', async () => {
    const child = await spawnChild();

    await closeThenReopenFresh(child.id);

    expect(lastLaunch().resuming).toBe(false);
    expect(lastLaunch().seededPrompt).toBeUndefined();
    expect(sessions.recentOutput(child.id)).toContain(NOTICE_WITHOUT_PROMPT);
  });

  it('tells the terminal that the previous conversation was not resumed when it replays the brief', async () => {
    const child = await spawnChild({ brief: BRIEF });

    await closeThenReopenFresh(child.id);

    expect(sessions.recentOutput(child.id)).toContain(NOTICE_WITH_PROMPT);
  });

  it('keeps the new conversation for the next relaunch, so a later resume does not go back to the old one', async () => {
    const child = await spawnChild({ brief: BRIEF });
    await closeThenReopenFresh(child.id);
    const freshConversation = lastLaunch().cliSessionId!;
    harness.markPrompted(freshConversation);
    await sessions.close(child.id);

    sessions.reopen(child.id, { mode: 'resume' });

    expect(lastLaunch().resuming).toBe(true);
    expect(lastLaunch().cliSessionId).toBe(freshConversation);
    expect(lastLaunch().seededPrompt).toBeUndefined();
  });

  it('does not replay the brief when it is plainly resumed', async () => {
    const child = await spawnChild({ brief: BRIEF });
    harness.markPrompted(child.id);
    await sessions.close(child.id);

    sessions.reopen(child.id, { mode: 'resume' });

    expect(lastLaunch().resuming).toBe(true);
    expect(lastLaunch().seededPrompt).toBeUndefined();
  });

  it('recognizes the replayed brief as the daemon-seeded prompt', async () => {
    const child = await spawnChild({ brief: BRIEF });

    await closeThenReopenFresh(child.id);

    expect(sessions.isSeededPrompt(child.id, BRIEF)).toBe(true);
  });
});

describe('the queue of a session reopened fresh', () => {
  it('keeps the messages of agents and humans and drops the stale pulse lines', async () => {
    const child = await spawnChild({ brief: BRIEF });
    await sessions.close(child.id);
    const queue = new MessageQueue(db);
    queue.enqueue({ sessionId: child.id, body: PULSE_LINE });
    queue.enqueue({ sessionId: child.id, body: AGENT_MESSAGE });

    sessions.reopen(child.id, { mode: 'fresh' });

    expect(queue.listQueued(child.id).map((message) => message.body)).toEqual([AGENT_MESSAGE]);
  });

  it('keeps the pulse lines when the session is merely resumed', async () => {
    const child = await spawnChild({ brief: BRIEF });
    await sessions.close(child.id);
    new MessageQueue(db).enqueue({ sessionId: child.id, body: PULSE_LINE });

    sessions.reopen(child.id, { mode: 'resume' });

    expect(new MessageQueue(db).countPending(child.id)).toBe(1);
  });
});

describe('the children of a manager reopened fresh', () => {
  it('stay attached to it and keep running', async () => {
    const managerRepository = new ManagerRepository(db);
    const manager = await sessions.create({ directory, name: 'manager', emoji: '🧭', harness: 'fake', role: MANAGER_ROLE });
    managerRepository.insert({ sessionId: manager.id, pulseSeconds: 600, childrenCap: 4, missionText: 'Run the fleet.', createdAt: manager.createdAt });
    const child = await spawnChild({ brief: BRIEF, parentId: manager.id });

    await closeThenReopenFresh(manager.id);

    const childAfter = sessions.get(child.id)!;
    expect(childAfter.parentId).toBe(manager.id);
    expect(childAfter.state).not.toBe('closed');
    expect(lastLaunch().seededPrompt).toBe('Run the fleet.');
  });
});
