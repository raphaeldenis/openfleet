import { E2E_FLAG_ENV, E2E_FLAG_ON, type Approval } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { FakeHarness, type FakeHandle } from '../harness/fakeHarness.js';
import { createTempDirTracker } from '../tempDirTracker.js';

const tempDirs = createTempDirTracker();
let daemon: Daemon;
let config: Config;

const LONG_QUOTED_MULTILINE_COMMAND = `git commit -m "feat: it's \\"quoted\\"" \\\n  && echo '${'x'.repeat(600)}'\nprintf "%s\\n" done`;

const adminApi = (path: string, init: RequestInit = {}) => fetch(`${daemon.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}` } });
const fakeHarness = () => daemon.harnesses.find((harness) => harness.id === 'fake') as FakeHarness;
const stateOf = async (sessionId: string) => ((await (await adminApi('/api/sessions')).json()) as { id: string; state: string; name: string }[]).find((session) => session.id === sessionId)!;
const pendingApprovals = async () => (await (await adminApi('/api/approvals')).json()) as Approval[];

async function eventually<T>(read: () => Promise<T>, isReady: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 100 && !isReady(value); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    value = await read();
  }
  return value;
}

async function sessionWithCliAtPermissionGate(command: string): Promise<{ sessionId: string; handle: FakeHandle; decision: Promise<Response> }> {
  const created = (await (await adminApi('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'Gimli', harness: 'fake', emoji: '⚔️' }) })).json()) as { id: string };
  const handle = fakeHarness().handles[0]!;
  // The test daemon listens on an ephemeral port (OPENFLEET_PORT=0), which the launch's hook URL, built from the configured port, does not carry.
  handle.hookUrl = `${daemon.server.url}${new URL(handle.hookUrl!).pathname}`;
  await fetch(handle.hookUrl!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', hook_event_name: 'SessionStart' }) });
  const decision = handle.requestPermission({ sessionId: 'c', toolName: 'Bash', toolInput: { command } });
  await eventually(pendingApprovals, (approvals) => approvals.length > 0);
  return { sessionId: created.id, handle, decision };
}

beforeEach(async () => {
  config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-qe-gate01-'), OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  daemon = await startDaemon(config);
});
afterEach(async () => { await daemon.close(); tempDirs.removeAll(); });

describe('QE — a session whose CLI waits at a permission gate, on a booted daemon', () => {
  it('lists the pending approval with the tool name and the complete command, and the session waits for permission', async () => {
    const { sessionId } = await sessionWithCliAtPermissionGate(LONG_QUOTED_MULTILINE_COMMAND);

    const approvals = await pendingApprovals();
    const session = await eventually(() => stateOf(sessionId), (found) => found.state === 'waiting_permission');

    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ sessionId, toolName: 'Bash', status: 'pending', toolInput: { command: LONG_QUOTED_MULTILINE_COMMAND } });
    expect(session.state).toBe('waiting_permission');
  });

  it.each([['allow'], ['deny']] as const)('keeps the approval on the same session after a rename, and the %s decision settles the waiting CLI', async (behavior) => {
    const { sessionId, decision } = await sessionWithCliAtPermissionGate(LONG_QUOTED_MULTILINE_COMMAND);
    const [approvalBeforeRename] = await pendingApprovals();

    await adminApi(`/api/sessions/${sessionId}`, { method: 'PATCH', body: JSON.stringify({ name: 'Gimli the Renamed' }) });
    const [approvalAfterRename] = await pendingApprovals();
    await adminApi(`/api/approvals/${approvalAfterRename!.id}/decide`, { method: 'POST', body: JSON.stringify({ behavior }) });
    const answer = (await (await decision).json()) as { hookSpecificOutput: { decision: { behavior: string } } };

    expect((await stateOf(sessionId)).name).toBe('Gimli the Renamed');
    expect(approvalAfterRename).toMatchObject({ id: approvalBeforeRename!.id, sessionId });
    expect(answer.hookSpecificOutput.decision.behavior).toBe(behavior);
    expect(await pendingApprovals()).toEqual([]);
  });
});
