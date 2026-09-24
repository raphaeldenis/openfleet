import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ApprovalService } from '../governance/approvalService.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

let server: Awaited<ReturnType<typeof startServer>>;
let sessions: SessionService;
let approvals: ApprovalService;
let hookToken: string;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  approvals = new ApprovalService({ db, bus, timeoutMs: 100 });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, bus });
  const session = await sessions.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
  hookToken = (db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(session.id) as { hook_token: string }).hook_token;
});
afterEach(() => server.close());

const post = (path: string, body: unknown) => fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /hooks/:token', () => {
  it('moves the session to idle on SessionStart', async () => {
    const res = await post(`/hooks/${hookToken}`, { session_id: 'c', hook_event_name: 'SessionStart' });
    expect(res.status).toBe(200);
    expect(sessions.list()[0]!.state).toBe('idle');
  });

  it('unknown token is a no-op 200', async () => {
    const res = await post('/hooks/nope', { session_id: 'c', hook_event_name: 'Stop' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('PermissionRequest waits for the decision and answers allow', async () => {
    const pending = post(`/hooks/${hookToken}`, { session_id: 'c', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
    await new Promise((r) => setTimeout(r, 20));
    const approval = approvals.listPending()[0]!;
    approvals.decide({ approvalId: approval.id, behavior: 'allow' });
    const body = await (await pending).json();
    expect(body).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: 'allow', decisionReason: 'approved in OpenFleet' } });
    expect(sessions.list()[0]!.state).toBe('generating');
  });

  it('PermissionRequest answers ask when nobody decides in time', async () => {
    const res = await post(`/hooks/${hookToken}`, { session_id: 'c', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} });
    expect((await res.json()).hookSpecificOutput.decision).toBe('ask');
  });
});
