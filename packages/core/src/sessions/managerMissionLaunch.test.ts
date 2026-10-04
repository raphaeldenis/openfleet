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
import { SessionService } from './sessionService.js';

const IMPORTED_AT = '2026-09-14T14:45:11.900Z';
const REAL_SIZED_MISSION_BYTES = 38 * 1024;
const aMissionOfSize = (bytes: number) => `START-OF-MISSION ${'m'.repeat(bytes - 'START-OF-MISSION '.length - 'END-OF-MISSION'.length)}END-OF-MISSION`;

let db: DatabaseSync;
let harness: FakeHarness;
let sessions: SessionService;
let sessionRepository: SessionRepository;
let managerRepository: ManagerRepository;
let managerDirectory: string;

/** A manager as the Scape importer stores it: closed, never started, with its managers row. */
function insertImportedManager({ id, mission }: { id: string; mission: string }): void {
  const [hookToken, mcpToken] = [newToken(), newToken()];
  sessionRepository.insert({
    id, name: 'Imported', emoji: '🤖', directory: managerDirectory, worktree: null, model: 'sonnet', parent_id: null, role: MANAGER_ROLE, harness: 'fake',
    state: 'closed', state_since: IMPORTED_AT, hook_token: hookToken, mcp_token: mcpToken, permission_mode: null, branch: null, project_id: null, created_at: IMPORTED_AT,
  });
  sessionRepository.setClosed(id, undefined, IMPORTED_AT, hookToken, mcpToken);
  managerRepository.insert({ sessionId: id, pulseSeconds: 600, childrenCap: 4, missionText: mission, createdAt: IMPORTED_AT });
}

const insertPlainClosedSession = (id: string): void => {
  const [hookToken, mcpToken] = [newToken(), newToken()];
  sessionRepository.insert({
    id, name: 'Plain', emoji: '🧒', directory: managerDirectory, worktree: null, model: null, parent_id: null, role: null, harness: 'fake',
    state: 'closed', state_since: IMPORTED_AT, hook_token: hookToken, mcp_token: mcpToken, permission_mode: null, branch: null, project_id: null, created_at: IMPORTED_AT,
  });
  sessionRepository.setClosed(id, undefined, IMPORTED_AT, hookToken, mcpToken);
};

const lastLaunch = () => harness.launches.at(-1)!;

beforeEach(() => {
  managerDirectory = mkdtempSync(join(tmpdir(), 'of-mission-launch-'));
  db = openDatabase(':memory:');
  harness = new FakeHarness();
  sessionRepository = new SessionRepository(db);
  managerRepository = new ManagerRepository(db);
  sessions = new SessionService({
    db, bus: new EventBus(), harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: join(managerDirectory, 'worktrees'),
    missionOf: (sessionId) => managerRepository.get(sessionId)?.missionText,
  });
});
afterEach(() => {
  db.close();
  rmSync(managerDirectory, { recursive: true, force: true });
});

describe('an imported manager receives its whole mission when it starts a fresh conversation', () => {
  it('launches a reopened, never started manager with the full 38 KB mission as its first prompt', () => {
    const mission = aMissionOfSize(REAL_SIZED_MISSION_BYTES);
    insertImportedManager({ id: 'imported-manager', mission });
    harness.missingConversations.add('imported-manager');

    sessions.reopen('imported-manager');

    expect(lastLaunch().resuming).toBe(false);
    const isFullMissionTheFirstPrompt = lastLaunch().seededPrompt === mission;
    expect(isFullMissionTheFirstPrompt).toBe(true);
  });

  it('recognizes the mission as the daemon-seeded prompt, so the handover recorder skips it', () => {
    const mission = aMissionOfSize(2_000);
    insertImportedManager({ id: 'imported-manager', mission });
    harness.missingConversations.add('imported-manager');

    sessions.reopen('imported-manager');

    expect(sessions.isSeededPrompt('imported-manager', mission)).toBe(true);
  });

  it('does not replay the mission into a conversation that is really resumed, which already holds it', () => {
    insertImportedManager({ id: 'imported-manager', mission: aMissionOfSize(2_000) });

    sessions.reopen('imported-manager');

    expect(lastLaunch().resuming).toBe(true);
    expect(lastLaunch().seededPrompt).toBeUndefined();
  });

  it('gives a session that is no manager no prompt', () => {
    insertPlainClosedSession('plain-session');
    harness.missingConversations.add('plain-session');

    sessions.reopen('plain-session');

    expect(lastLaunch().seededPrompt).toBeUndefined();
  });

  it('refuses to put a mission above the maximum on the command line, and starts the manager without a prompt', () => {
    insertImportedManager({ id: 'imported-manager', mission: aMissionOfSize(MAX_MISSION_BYTES + 1) });
    harness.missingConversations.add('imported-manager');

    sessions.reopen('imported-manager');

    expect(lastLaunch().seededPrompt).toBeUndefined();
  });
});
