import { E2E_FLAG_ENV, E2E_FLAG_ON, type CommandPolicyDocument } from '@openfleet/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { startDaemon, type Daemon, type DaemonOptions } from './daemon.js';
import { DEFAULT_COMMAND_POLICY } from './policy/defaultCommandPolicy.js';
import { defaultCommandPolicySettings, type CommandPolicySettings } from './policy/commandPolicySettings.js';
import { createTempDirTracker } from './tempDirTracker.js';

const tempDirs = createTempDirTracker();
let daemon: Daemon | undefined;
let adminToken: string;

const enforcing = (changes: { document?: Partial<CommandPolicyDocument> } = {}): CommandPolicySettings => {
  const defaults = defaultCommandPolicySettings();
  return { document: { ...DEFAULT_COMMAND_POLICY, mode: 'enforce', ...changes.document }, unattended: defaults.unattended };
};

async function bootDaemon(commandPolicy?: DaemonOptions['commandPolicy']): Promise<Daemon> {
  const home = tempDirs.make('of-daemon-sendmessage-');
  const config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  adminToken = config.adminToken;
  daemon = await startDaemon(config, { commandPolicy });
  return daemon;
}
afterEach(async () => { vi.restoreAllMocks(); await daemon?.close(); daemon = undefined; tempDirs.removeAll(); });

const api = (path: string, init: RequestInit = {}) => fetch(`${daemon!.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}`, ...(init.headers ?? {}) } });
const createSession = async (extra: Record<string, unknown> = {}) =>
  (await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: '/tmp', name: 'Boss', harness: 'fake', emoji: '🤖', ...extra }) })).json()) as { id: string };
const createManager = (name: string) => createSession({ name, manager: { childrenCap: 4, mission: 'keep the fleet moving' } });
const hookTokenOf = (sessionId: string) => (daemon!.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(sessionId) as { hook_token: string }).hook_token;

interface HookAnswer { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }
const sendMessage = async (callerId: string, to: string): Promise<HookAnswer> => {
  const body = { session_id: 'cli-1', cwd: '/tmp', hook_event_name: 'PreToolUse', tool_name: 'SendMessage', tool_input: { to, message: 'status?' } };
  const response = await fetch(`${daemon!.server.url}/hooks/${hookTokenOf(callerId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return response.json() as Promise<HookAnswer>;
};

describe('a manager calls the generic SendMessage tool of the harness', () => {
  it('is refused when it addresses a session by uuid, with a pointer to the fleet tools', async () => {
    await bootDaemon({ settings: enforcing() });
    const caller = await createManager('Lead');
    const target = await createManager('Forge');

    const answer = await sendMessage(caller.id, target.id);

    expect(answer.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('send_session_message') });
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('message_argus');
  });

  it('is refused when it addresses a manager by name', async () => {
    await bootDaemon({ settings: enforcing() });
    const caller = await createManager('Lead');
    await createManager('Forge');

    const answer = await sendMessage(caller.id, 'Forge');

    expect(answer.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
  });

  it('is let through when it addresses a sub-agent name that is no manager', async () => {
    await bootDaemon({ settings: enforcing() });
    const caller = await createManager('Lead');
    await createManager('Forge');

    const answer = await sendMessage(caller.id, 'researcher');

    expect(answer).toEqual({});
  });

  it('is let through when the name belongs to a plain worker session, not to a manager', async () => {
    await bootDaemon({ settings: enforcing() });
    const caller = await createManager('Lead');
    await createSession({ name: 'Worker' });

    const answer = await sendMessage(caller.id, 'Worker');

    expect(answer).toEqual({});
  });

  it('journals the refusal under the SendMessage tool', async () => {
    await bootDaemon({ settings: enforcing() });
    const caller = await createManager('Lead');
    const target = await createManager('Forge');

    await sendMessage(caller.id, target.id);

    const rows = await vi.waitFor(() => {
      const found = daemon!.db.prepare('SELECT rule_id, tool_name, command_excerpt FROM denied_commands').all() as { rule_id: string; tool_name: string; command_excerpt: string }[];
      if (found.length === 0) throw new Error('not journaled yet');
      return found;
    });
    expect(rows[0]).toMatchObject({ rule_id: 'no-generic-send-message-to-fleet-session', tool_name: 'SendMessage', command_excerpt: target.id });
  });
});
