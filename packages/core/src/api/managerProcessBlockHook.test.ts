import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { SessionService } from '../sessions/sessionService.js';
import { SessionStartContext } from '../workingState/sessionStartContext.js';
import { StopRefusal } from '../workingState/stopRefusal.js';
import { WorkingStateService } from '../workingState/workingStateService.js';
import type { WorkingStateSettings } from '../workingState/workingStateSettings.js';
import { startServer } from './server.js';

const PROCESS_HEADING = '\n# Process (';
const NO_PROCESS_SECTION_LINE = 'Process: no "## Process" section in the mission note';
const PROCESS_CAP_BYTES = 1_500;
const PROJECT_ID = 'project-process';
const NOTE_ID = 'note-process';
const CONTEXT_BUDGET_CHARACTERS = 9_000;
const SOURCES_OF_A_MANAGER = ['startup', 'resume', 'clear', 'compact'];
const PIPELINE = '1. PM writes the spec\n2. QE tests\n3. QA drives the browser\nGuard-rail: never merge without a green CI';

interface HookAnswer { hookSpecificOutput?: { hookEventName: string; additionalContext: string } }

let db: DatabaseSync;
let server: Awaited<ReturnType<typeof startServer>>;
let sessions: SessionService;
let managers: ManagerService;
let scratchRoot: string;

const sizeInBytes = (text: string) => Buffer.byteLength(text, 'utf8');

async function startFixture() {
  db = openDatabase(':memory:');
  const bus = new EventBus();
  sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: join(scratchRoot, 'worktrees') });
  const approvals = new ApprovalService({ db, bus, timeoutMs: 100 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const settings: WorkingStateSettings = { maxBytes: 8192, enforce: true, maxAgeMinutes: 30 };
  const clock = () => new Date().toISOString();
  const workingStates = new WorkingStateService({ db, clock, stateRoot: join(scratchRoot, 'state'), maxBytes: settings.maxBytes });
  const stopRefusal = new StopRefusal({ db, workingStates, settings, clock });
  const sessionStartContext = new SessionStartContext({ db, workingStates, settings, clock });
  new ProjectRepository(db).insert({ id: PROJECT_ID, name: 'Process', docsFolderPath: null, createdAt: clock() });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: join(scratchRoot, 'config.json'), stopRefusal, sessionStartContext });
}

const hookTokenOf = (id: string) => (db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(id) as { hook_token: string }).hook_token;
const sessionStarted = async (sessionId: string, source: string) => {
  const response = await fetch(`${server.url}/hooks/${hookTokenOf(sessionId)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', hook_event_name: 'SessionStart', source }),
  });
  return ((await response.json()) as HookAnswer).hookSpecificOutput?.additionalContext ?? '';
};
const aManager = async () => {
  const { id } = await managers.createManagerSession({ directory: scratchRoot, name: 'Boss', harness: 'fake', emoji: '🤖', manager: { childrenCap: 3, mission: 'seed' } });
  return id;
};
const aManagerLinkedToNote = async (noteBody: string) => {
  const id = await aManager();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO notes (id, project_id, title, body_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(NOTE_ID, PROJECT_ID, 'Mission', noteBody, now, now);
  db.prepare('UPDATE managers SET mission_note_id = ? WHERE session_id = ?').run(NOTE_ID, id);
  return id;
};
const processBlockOf = (context: string) => context.slice(context.indexOf(PROCESS_HEADING));

beforeEach(async () => {
  scratchRoot = mkdtempSync(join(tmpdir(), 'of-process-hook-'));
  await startFixture();
});
afterEach(async () => {
  await server.close();
  rmSync(scratchRoot, { recursive: true, force: true });
});

describe('the Process block of a manager context', () => {
  it.each(SOURCES_OF_A_MANAGER)('carries the Process section of the mission note on %s', async (source) => {
    const managerId = await aManagerLinkedToNote(`# Mission\nship it\n\n## process\n${PIPELINE}\n\n## Laws\nnone`);

    const context = await sessionStarted(managerId, source);

    expect(context).toContain(PROCESS_HEADING);
    expect(context).toContain(PIPELINE);
    expect(context).not.toContain('## Laws');
    expect(context).not.toContain(NO_PROCESS_SECTION_LINE);
  });

  it('says there is no Process section when the note has none', async () => {
    const managerId = await aManagerLinkedToNote('# Mission\nship it\n\n## Laws\nnone');

    const context = await sessionStarted(managerId, 'compact');

    expect(context).toContain(NO_PROCESS_SECTION_LINE);
    expect(context).not.toContain(PROCESS_HEADING);
  });

  it('cuts a 5 KB Process section at the cap and tells the manager to read the note', async () => {
    const managerId = await aManagerLinkedToNote(`## Process\nSTART-OF-PROCESS\n${'p'.repeat(5_000)}\nEND-OF-PROCESS\n\n## Laws\nnone`);

    const context = await sessionStarted(managerId, 'compact');

    const processBlock = processBlockOf(context);
    const processBody = processBlock.slice(0, processBlock.indexOf('[truncated'));
    expect(context).toContain('START-OF-PROCESS');
    expect(context).not.toContain('END-OF-PROCESS');
    expect(processBlock).toMatch(/\[truncated, \d+ bytes in total: .*get_note/);
    expect(sizeInBytes(processBody)).toBeLessThanOrEqual(PROCESS_CAP_BYTES + 200);
  });

  it('says there is no Process section when the manager has no linked note', async () => {
    const managerId = await aManager();

    const context = await sessionStarted(managerId, 'startup');

    expect(context).toContain(NO_PROCESS_SECTION_LINE);
  });

  it('adds no Process block to an ordinary session', async () => {
    const { id } = await sessions.create({ directory: scratchRoot, name: 'Plain', harness: 'fake', emoji: '🙂' });

    const context = await sessionStarted(id, 'compact');

    expect(context).not.toContain(PROCESS_HEADING);
    expect(context).not.toContain(NO_PROCESS_SECTION_LINE);
  });

  it('keeps the Process block whole while the budget shrinks the Mission preview', async () => {
    const managerId = await aManagerLinkedToNote(`## Process\n${PIPELINE}`);
    db.prepare('UPDATE managers SET mission_text = ? WHERE session_id = ?').run(`HEAD-OF-MISSION ${'m'.repeat(40_000)}`, managerId);
    for (let index = 0; index < 40; index += 1) {
      await sessions.create({ directory: `/tmp/${'d'.repeat(180)}`, name: `Child-${String(index).padStart(2, '0')}`, harness: 'fake', emoji: '🧒', parentId: managerId });
    }

    const context = await sessionStarted(managerId, 'compact');

    expect(context).toContain(PIPELINE);
    expect(context.length).toBeLessThanOrEqual(CONTEXT_BUDGET_CHARACTERS);
  });
});
