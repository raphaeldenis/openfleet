import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MANAGER_ROLE, MAX_MISSION_BYTES } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { newToken } from '../ids.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { SessionRepository } from './sessionRepository.js';
import { SessionReopenError, SessionService } from './sessionService.js';

const CLOSED_AT = '2026-09-14T14:45:11.900Z';
const MANAGER_ID = 'closed-manager';
const PREVIOUS_CONVERSATION_ID = 'previous-conversation';
const MISSION = 'Ship the roadmap, one pull request at a time.';

let db: DatabaseSync;
let harness: FakeHarness;
let sessions: SessionService;
let sessionRepository: SessionRepository;
let managerRepository: ManagerRepository;
let directory: string;

function insertClosedSession({ id, role, mission }: { id: string; role: string | null; mission?: string }): void {
  const [hookToken, mcpToken] = [newToken(), newToken()];
  sessionRepository.insert({
    id, name: id, emoji: '🤖', directory, worktree: null, model: 'sonnet', parent_id: null, role, harness: 'fake',
    state: 'closed', state_since: CLOSED_AT, hook_token: hookToken, mcp_token: mcpToken, permission_mode: null, branch: null, project_id: null, created_at: CLOSED_AT,
  });
  sessionRepository.setClosed(id, undefined, CLOSED_AT, hookToken, mcpToken);
  sessionRepository.setCliSessionId(id, PREVIOUS_CONVERSATION_ID);
  if (mission !== undefined) managerRepository.insert({ sessionId: id, pulseSeconds: 600, childrenCap: 4, missionText: mission, createdAt: CLOSED_AT });
}

const lastLaunch = () => harness.launches.at(-1)!;
const refusalCodeOf = (attempt: () => unknown): string | undefined => {
  try {
    attempt();
  } catch (error) {
    return error instanceof SessionReopenError ? error.code : undefined;
  }
  return undefined;
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'of-fresh-reopen-'));
  db = openDatabase(':memory:');
  harness = new FakeHarness();
  sessionRepository = new SessionRepository(db);
  managerRepository = new ManagerRepository(db);
  sessions = new SessionService({
    db, bus: new EventBus(), harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: join(directory, 'worktrees'),
    missionOf: (sessionId) => managerRepository.get(sessionId)?.missionText,
  });
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('reopening a closed manager fresh', () => {
  it('starts a new conversation seeded with the whole mission, although the previous conversation still exists', () => {
    insertClosedSession({ id: MANAGER_ID, role: MANAGER_ROLE, mission: MISSION });

    sessions.reopen(MANAGER_ID, { mode: 'fresh' });

    expect(lastLaunch().resuming).toBe(false);
    expect(lastLaunch().seededPrompt).toBe(MISSION);
    expect(lastLaunch().cliSessionId).not.toBe(PREVIOUS_CONVERSATION_ID);
  });

  it('keeps the new conversation for the next relaunch', () => {
    insertClosedSession({ id: MANAGER_ID, role: MANAGER_ROLE, mission: MISSION });

    sessions.reopen(MANAGER_ID, { mode: 'fresh' });

    expect(sessionRepository.cliSessionId(MANAGER_ID)).toBe(lastLaunch().cliSessionId);
  });

  it('refuses a manager whose mission is empty, and leaves it closed on its previous conversation', () => {
    insertClosedSession({ id: MANAGER_ID, role: MANAGER_ROLE, mission: '   ' });

    const refusalCode = refusalCodeOf(() => sessions.reopen(MANAGER_ID, { mode: 'fresh' }));

    expect(refusalCode).toBe('mission_missing');
    expect(harness.launches).toHaveLength(0);
    expect(sessions.get(MANAGER_ID)?.state).toBe('closed');
    expect(sessionRepository.cliSessionId(MANAGER_ID)).toBe(PREVIOUS_CONVERSATION_ID);
  });

  it('refuses a mission above the maximum instead of starting the manager without it', () => {
    insertClosedSession({ id: MANAGER_ID, role: MANAGER_ROLE, mission: 'm'.repeat(MAX_MISSION_BYTES + 1) });

    expect(refusalCodeOf(() => sessions.reopen(MANAGER_ID, { mode: 'fresh' }))).toBe('mission_too_large');
    expect(harness.launches).toHaveLength(0);
  });

  it('refuses a session that is no manager', () => {
    insertClosedSession({ id: 'plain-session', role: null });

    expect(refusalCodeOf(() => sessions.reopen('plain-session', { mode: 'fresh' }))).toBe('not_a_manager');
    expect(harness.launches).toHaveLength(0);
  });
});

describe('resuming a closed manager', () => {
  it('goes back into the previous conversation without replaying the mission', () => {
    insertClosedSession({ id: MANAGER_ID, role: MANAGER_ROLE, mission: MISSION });

    sessions.reopen(MANAGER_ID, { mode: 'resume' });

    expect(lastLaunch().resuming).toBe(true);
    expect(lastLaunch().cliSessionId).toBe(PREVIOUS_CONVERSATION_ID);
    expect(lastLaunch().seededPrompt).toBeUndefined();
  });

  it('is what reopening does when no mode is given', () => {
    insertClosedSession({ id: MANAGER_ID, role: MANAGER_ROLE, mission: MISSION });

    sessions.reopen(MANAGER_ID);

    expect(lastLaunch().resuming).toBe(true);
  });
});
