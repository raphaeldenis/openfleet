import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

let server: Awaited<ReturnType<typeof startServer>>;
let db: DatabaseSync;
let sessions: SessionService;
let approvals: ApprovalService;
let hookToken: string;

const SHORT_APPROVAL_TIMEOUT_MS = 100;

beforeEach(async () => {
  db = openDatabase(':memory:');
  const bus = new EventBus();
  sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  approvals = new ApprovalService({ db, bus, timeoutMs: SHORT_APPROVAL_TIMEOUT_MS });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json' });
  const session = await sessions.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
  hookToken = (db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(session.id) as { hook_token: string }).hook_token;
});
afterEach(() => server.close());

const askPermissionFor = async (toolName: string) => {
  const response = await fetch(`${server.url}/hooks/${hookToken}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'c', hook_event_name: 'PermissionRequest', tool_name: toolName, tool_input: {} }),
  });
  return response.json();
};
const decisionOf = (hookAnswer: unknown) => (hookAnswer as { hookSpecificOutput?: { decision?: { behavior: string } } }).hookSpecificOutput?.decision?.behavior;

describe('the working state tools never wait for a human', () => {
  it.each(['mcp__openfleet__update_working_state', 'mcp__openfleet__get_working_state'])('allows %s at once with no Inbox approval and leaves the session generating', async (toolName) => {
    const answer = await askPermissionFor(toolName);

    expect(decisionOf(answer)).toBe('allow');
    expect(approvals.listPending()).toEqual([]);
    expect(sessions.list()[0]!.state).toBe('generating');
  });

  it.each(['mcp__other__update_working_state', 'mcp__openfleet__update_working_state_now', 'update_working_state', 'mcp__openfleet__update_session'])('still raises an Inbox approval for %s', async (toolName) => {
    const pendingAnswer = askPermissionFor(toolName);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(approvals.listPending().map((approval) => approval.toolName)).toEqual([toolName]);
    await pendingAnswer;
  });
});
