import { E2E_FLAG_ENV, E2E_FLAG_ON, type Approval } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { FakeHarness, type FakeHandle } from '../harness/fakeHarness.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const APPROVAL_TIMEOUT_MS = 150;
const tempDirs = createTempDirTracker();
let daemon: Daemon;
let config: Config;

const adminApi = (path: string) => fetch(`${daemon.server.url}${path}`, { headers: { authorization: `Bearer ${config.adminToken}` } });
const fakeHarness = () => daemon.harnesses.find((harness) => harness.id === 'fake') as FakeHarness;
const stateOf = async (sessionId: string) => ((await (await adminApi('/api/sessions')).json()) as { id: string; state: string }[]).find((session) => session.id === sessionId)!.state;
const approvalsOfSession = (sessionId: string) => daemon.db.prepare('SELECT status FROM approvals WHERE session_id = ? ORDER BY created_at').all(sessionId) as { status: Approval['status'] }[];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const postHook = (handle: FakeHandle, body: object) => fetch(handle.hookUrl!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', ...body }) });

async function sessionWhoseApprovalExpired() {
  const created = (await (await fetch(`${daemon.server.url}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}` }, body: JSON.stringify({ directory: '/tmp', name: 'Gimli', harness: 'fake', emoji: '⚔️' }) })).json()) as { id: string };
  const handle = fakeHarness().handles[0]!;
  // The test daemon listens on an ephemeral port (OPENFLEET_PORT=0), which the launch's hook URL, built from the configured port, does not carry.
  handle.hookUrl = `${daemon.server.url}${new URL(handle.hookUrl!).pathname}`;
  await postHook(handle, { hook_event_name: 'SessionStart' });
  const answer = await handle.requestPermission({ sessionId: 'c', toolName: 'Bash', toolInput: { command: 'gh pr merge 1' } });
  return { sessionId: created.id, handle, answer };
}

beforeEach(async () => {
  config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-qe-gate02-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  daemon = await startDaemon(config, { approvalTimeoutMs: APPROVAL_TIMEOUT_MS });
});
afterEach(async () => { await daemon.close(); tempDirs.removeAll(); });

describe('QE — a permission approval that expires while the CLI still waits in its terminal', () => {
  it('answers the hook with {} so the CLI asks in its terminal, expires the approval, and keeps the session waiting for permission', async () => {
    const { sessionId, answer } = await sessionWhoseApprovalExpired();

    expect(await answer.json()).toEqual({});
    expect(approvalsOfSession(sessionId)).toEqual([{ status: 'expired' }]);
    expect(await stateOf(sessionId)).toBe('waiting_permission');
  });

  it('creates no further approval while the session keeps waiting', async () => {
    const { sessionId } = await sessionWhoseApprovalExpired();

    await wait(APPROVAL_TIMEOUT_MS * 3);

    expect(approvalsOfSession(sessionId)).toEqual([{ status: 'expired' }]);
  });

  it('leaves waiting_permission as soon as the CLI hooks again after the human answered in the terminal', async () => {
    const { sessionId, handle } = await sessionWhoseApprovalExpired();

    await postHook(handle, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr merge 1' } });

    expect(await stateOf(sessionId)).toBe('generating');
    expect(approvalsOfSession(sessionId)).toEqual([{ status: 'expired' }]);
  });
});
