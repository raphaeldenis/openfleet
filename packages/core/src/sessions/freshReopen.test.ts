import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MANAGER_ROLE, MAX_MISSION_BYTES } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import type { HarnessHandle } from '../harness/harness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { NoteRepository } from '../notes/noteRepository.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { MessageQueue } from './messageQueue.js';
import { SessionRepository } from './sessionRepository.js';
import { SessionService } from './sessionService.js';

const BRIEF = 'Fix the flaky login test, then report to your manager.';
const PULSE_LINE = '[pulse] Re-read your mission and continue: check your children, unblock them, record what you did.';
const AGENT_MESSAGE = 'Please also look at the CI cache.';
const NOTICE_WITH_PROMPT = 'Started a new conversation. The previous one was not resumed.';
const NOTICE_WITHOUT_PROMPT = 'Started a new conversation with no starting prompt: none is stored for this session.';
const NOTICE_WITH_TOO_LARGE_PROMPT = 'Started a new conversation with no starting prompt: the stored one is above the size a first prompt may have.';

class RefusingHarness extends FakeHarness {
  override start(): HarnessHandle {
    throw new Error('the CLI cannot start');
  }
}

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

  it('recognizes the replayed brief as the daemon-seeded prompt after a daemon restart', async () => {
    const child = await spawnChild({ brief: BRIEF });
    await sessions.close(child.id);
    const restarted = serviceOn(db, new FakeHarness());
    expect(restarted.isSeededPrompt(child.id, BRIEF)).toBe(false);

    restarted.reopen(child.id, { mode: 'fresh' });

    expect(restarted.isSeededPrompt(child.id, BRIEF)).toBe(true);
  });

  it('relaunches the new conversation, not the old one, when the daemon restarts before the first prompt', async () => {
    const child = await spawnChild({ brief: BRIEF });
    const conversationBefore = new SessionRepository(db).cliSessionId(child.id) ?? child.id;
    await closeThenReopenFresh(child.id);
    const freshConversation = lastLaunch().cliSessionId!;
    await sessions.close(child.id);
    const restarted = serviceOn(db, harness);

    restarted.reopen(child.id, { mode: 'resume' });

    expect(lastLaunch().cliSessionId).toBe(freshConversation);
    expect(lastLaunch().cliSessionId).not.toBe(conversationBefore);
    expect(lastLaunch().resuming).toBe(false);
    expect(lastLaunch().seededPrompt).toBeUndefined();
  });
});

describe('a plain resume of a child', () => {
  it('does not replay the brief when its conversation is gone', async () => {
    const child = await spawnChild({ brief: BRIEF });
    harness.markPrompted(child.id);
    harness.missingConversations.add(child.id);
    await sessions.close(child.id);

    sessions.reopen(child.id, { mode: 'resume' });

    expect(lastLaunch().resuming).toBe(false);
    expect(lastLaunch().seededPrompt).toBeUndefined();
  });

  it('does not replay the brief when it never received a prompt', async () => {
    const child = await spawnChild({ brief: BRIEF });
    await sessions.close(child.id);

    sessions.reopen(child.id, { mode: 'resume' });

    expect(lastLaunch().resuming).toBe(false);
    expect(lastLaunch().seededPrompt).toBeUndefined();
  });
});

describe('the brief of a child at creation', () => {
  it('is refused above the size a first prompt may have, and no session is created', async () => {
    const aBriefOneByteTooLarge = 'b'.repeat(MAX_MISSION_BYTES + 1);

    const creation = spawnChild({ brief: aBriefOneByteTooLarge });

    await expect(creation).rejects.toMatchObject({ code: 'invalid_body' });
    await expect(creation).rejects.toThrow(/brief/i);
    expect(sessions.list()).toHaveLength(0);
    expect(harness.launches).toHaveLength(0);
  });

  it('is accepted at exactly the size a first prompt may have', async () => {
    const aBriefOfTheMaximumSize = 'b'.repeat(MAX_MISSION_BYTES);

    const child = await spawnChild({ brief: aBriefOfTheMaximumSize });

    expect(new SessionRepository(db).seededPrompt(child.id)).toBe(aBriefOfTheMaximumSize);
  });

  it('is not stored for a manager, whose mission is its own source of truth', async () => {
    const manager = await sessions.create({ directory, name: 'manager', emoji: '🧭', harness: 'fake', role: MANAGER_ROLE, seededPrompt: 'Run the fleet.' });

    expect(new SessionRepository(db).seededPrompt(manager.id)).toBeNull();
  });

  describe('when it was merged with a handoff', () => {
    const PROJECT = '11111111-1111-4111-8111-111111111111';
    const HANDOFF_TEXT = 'Next: ship the picker';
    const startFromHandoff = (brief?: string) =>
      sessions.create({ directory, name: 'child', emoji: '🧒', harness: 'fake', projectId: PROJECT, handoffFile: 'gimli.md', seededPrompt: brief });

    beforeEach(() => {
      const docs = join(directory, 'docs');
      mkdirSync(join(docs, 'handoffs'), { recursive: true });
      const handoffPath = join(docs, 'handoffs', 'gimli.md');
      writeFileSync(handoffPath, HANDOFF_TEXT);
      new ProjectRepository(db).insert({ id: PROJECT, name: 'Fleet', docsFolderPath: docs, createdAt: 't0' });
      new NoteRepository(db).insert({ id: 'gimli', projectId: PROJECT, folder: 'handoffs', title: 'gimli', filePath: handoffPath, bodyMd: '', sourceHash: null, rev: 1, shared: false, createdAt: '2026-09-01', updatedAt: '2026-10-04T10:00:00Z' });
    });

    it('is launched with the handoff block, and replayed on a fresh reopen as the raw brief only', async () => {
      const child = await startFromHandoff(BRIEF);
      expect(lastLaunch().seededPrompt).toContain(HANDOFF_TEXT);

      await closeThenReopenFresh(child.id);

      expect(lastLaunch().seededPrompt).toBe(BRIEF);
    });

    it('replays nothing on a fresh reopen when the session started from the handoff alone', async () => {
      const child = await startFromHandoff();
      expect(lastLaunch().seededPrompt).toContain(HANDOFF_TEXT);

      await closeThenReopenFresh(child.id);

      expect(lastLaunch().seededPrompt).toBeUndefined();
      expect(sessions.recentOutput(child.id)).toContain(NOTICE_WITHOUT_PROMPT);
    });
  });
});

describe('a fresh reopen of a child whose stored brief is above the size a first prompt may have', () => {
  it('starts with no prompt and says the stored one is too large, not that none is stored', async () => {
    const child = await spawnChild({ brief: BRIEF });
    db.prepare('UPDATE sessions SET seeded_prompt = ? WHERE id = ?').run('b'.repeat(MAX_MISSION_BYTES + 1), child.id);

    await closeThenReopenFresh(child.id);

    expect(lastLaunch().seededPrompt).toBeUndefined();
    expect(sessions.recentOutput(child.id)).toContain(NOTICE_WITH_TOO_LARGE_PROMPT);
    expect(sessions.recentOutput(child.id)).not.toContain(NOTICE_WITHOUT_PROMPT);
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

  it('keeps everything queued when the fresh launch fails', async () => {
    const child = await spawnChild({ brief: BRIEF });
    await sessions.close(child.id);
    const queue = new MessageQueue(db);
    queue.enqueue({ sessionId: child.id, body: PULSE_LINE });
    queue.enqueue({ sessionId: child.id, body: AGENT_MESSAGE });
    const failing = serviceOn(db, new RefusingHarness());

    expect(() => failing.reopen(child.id, { mode: 'fresh' })).toThrow();

    expect(queue.listQueued(child.id)).toHaveLength(2);
  });

  it('keeps the pulse lines of the other sessions', async () => {
    const child = await spawnChild({ brief: BRIEF });
    const sibling = await spawnChild({ brief: BRIEF });
    await sessions.close(child.id);
    const queue = new MessageQueue(db);
    queue.enqueue({ sessionId: sibling.id, body: PULSE_LINE });

    sessions.reopen(child.id, { mode: 'fresh' });

    expect(queue.listQueued(sibling.id)).toHaveLength(1);
  });

  it('keeps an agent message that merely starts with [pulse]', async () => {
    const child = await spawnChild({ brief: BRIEF });
    const sender = await spawnChild({ brief: BRIEF });
    await sessions.close(child.id);
    const queue = new MessageQueue(db);
    queue.enqueue({ sessionId: child.id, fromSessionId: sender.id, body: `${PULSE_LINE} (quoted by a colleague)` });

    sessions.reopen(child.id, { mode: 'fresh' });

    expect(queue.listQueued(child.id)).toHaveLength(1);
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
