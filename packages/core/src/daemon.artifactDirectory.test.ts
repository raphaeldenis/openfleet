import { mkdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_FLAG_ENV, E2E_FLAG_ON, type CommandPolicyDocument, type PolicyRule } from '@openfleet/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from './config.js';
import { startDaemon, type Daemon, type DaemonOptions } from './daemon.js';
import { openDatabase } from './db/database.js';
import { DEFAULT_COMMAND_POLICY } from './policy/defaultCommandPolicy.js';
import { defaultCommandPolicySettings } from './policy/commandPolicySettings.js';
import { ProjectRepository } from './projects/projectRepository.js';
import { createTempDirTracker } from './tempDirTracker.js';

const tempDirs = createTempDirTracker();
const PROJECT_ID = '3f2b8c1e-5d4a-4b6e-9a7c-1d2e3f4a5b6c';
const PROJECT_WITHOUT_DOCS_FOLDER_ID = '7a1d9e20-6c3b-4f58-8d41-2b9c0e5f6a73';
const MANAGER_NAME = 'Mnemosyne';
const SMALL_LIMITS = { artifacts: { maxFileBytes: 40, maxProjectBytes: 100 } };
let daemon: Daemon | undefined;
let config: Config;
let docsFolder: string;

afterEach(async () => {
  vi.restoreAllMocks();
  await daemon?.close();
  daemon = undefined;
  tempDirs.removeAll();
});

const ASK_BEFORE_WRITING_RULE_ID = 'ask-before-writing';
const askBeforeWriting: PolicyRule = { id: ASK_BEFORE_WRITING_RULE_ID, tools: ['Write'], decision: 'ask', when: {}, reason: 'Every Write needs a human look.' };

const policyAskingBeforeWrites = (): CommandPolicyDocument => ({
  ...DEFAULT_COMMAND_POLICY,
  rules: [askBeforeWriting, ...DEFAULT_COMMAND_POLICY.rules],
  profiles: {
    ...DEFAULT_COMMAND_POLICY.profiles,
    default: { rules: [ASK_BEFORE_WRITING_RULE_ID, ...DEFAULT_COMMAND_POLICY.profiles.default!.rules] },
    manager: { rules: [ASK_BEFORE_WRITING_RULE_ID, ...DEFAULT_COMMAND_POLICY.profiles.manager!.rules] },
  },
});

const policyObservingEveryRule = (): CommandPolicyDocument => ({ ...DEFAULT_COMMAND_POLICY, mode: 'observe' });

const policyOf = (document: CommandPolicyDocument): NonNullable<DaemonOptions['commandPolicy']> => {
  const defaults = defaultCommandPolicySettings();
  return { settings: { document, unattended: defaults.unattended } };
};

async function bootDaemon({ configJson, policyDocument = { ...DEFAULT_COMMAND_POLICY, mode: 'enforce' } }: { configJson?: Record<string, unknown>; policyDocument?: CommandPolicyDocument } = {}): Promise<Daemon> {
  const home = tempDirs.make('of-daemon-artifacts-');
  docsFolder = realpathSync.native(tempDirs.make('of-daemon-artifacts-docs-'));
  if (configJson !== undefined) writeFileSync(join(home, 'config.json'), JSON.stringify(configJson));
  config = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '0', [E2E_FLAG_ENV]: E2E_FLAG_ON });
  const seedDb = openDatabase(config.dbPath);
  const projects = new ProjectRepository(seedDb);
  projects.insert({ id: PROJECT_ID, name: 'One', docsFolderPath: docsFolder, createdAt: 't0' });
  projects.insert({ id: PROJECT_WITHOUT_DOCS_FOLDER_ID, name: 'Two', docsFolderPath: null, createdAt: 't0' });
  seedDb.close();
  mkdirSync(config.worktreesRoot, { recursive: true });
  daemon = await startDaemon(config, { commandPolicy: policyOf(policyDocument) });
  return daemon;
}

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon!.server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.adminToken}`, ...(init.headers ?? {}) } });
const createSession = async (extra: Record<string, unknown>) =>
  (await (await api('/api/sessions', { method: 'POST', body: JSON.stringify({ directory: config.worktreesRoot, harness: 'fake', emoji: '🤖', ...extra }) })).json()) as { id: string };
const createManager = ({ projectId = PROJECT_ID, name = MANAGER_NAME }: { projectId?: string; name?: string } = {}) =>
  createSession({ name, projectId, manager: { childrenCap: 2, mission: 'Ship the thing' } });
const createChildOf = (parentId: string) => createSession({ name: 'Worker', parentId, role: 'DEV' });
const hookTokenOf = (sessionId: string) => (daemon!.db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(sessionId) as { hook_token: string }).hook_token;

interface HookAnswer { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }
const preToolUse = async (sessionId: string, tool: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<HookAnswer> =>
  (await fetch(`${daemon!.server.url}/hooks/${hookTokenOf(sessionId)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'cli-1', cwd: '/tmp', hook_event_name: 'PreToolUse', ...tool, ...extra }),
  })).json() as Promise<HookAnswer>;
const write = (sessionId: string, filePath: string, content: string, extra: Record<string, unknown> = {}) =>
  preToolUse(sessionId, { tool_name: 'Write', tool_input: { file_path: filePath, content } }, extra);

const managerDirectoryOf = (name = MANAGER_NAME) => join(docsFolder, 'artifacts', name);
const journalRows = () => (daemon!.db.prepare("SELECT session_id, kind, payload_json FROM session_events WHERE kind LIKE 'artifact_write%' ORDER BY id").all() as { session_id: string; kind: string; payload_json: string }[])
  .map((row) => ({ sessionId: row.session_id, kind: row.kind, payload: JSON.parse(row.payload_json) as Record<string, unknown> }));
const decisionOf = (answer: HookAnswer) => answer.hookSpecificOutput?.permissionDecision;
const denialRows = () => daemon!.db.prepare('SELECT rule_id, outcome, tool_name FROM denied_commands ORDER BY created_at, rowid').all() as { rule_id: string; outcome: string; tool_name: string }[];
const isDirectory = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

describe('a Write to the artifact directory of a manager', () => {
  it('is allowed without a prompt for the manager and journaled in session_events with its actor', async () => {
    await bootDaemon();
    const manager = await createManager();
    const filePath = join(managerDirectoryOf(), 'pr-body.md');

    const answer = await write(manager.id, filePath, 'hello');

    expect(decisionOf(answer)).toBe('allow');
    expect(journalRows()).toEqual([{ sessionId: manager.id, kind: 'artifact_write', payload: expect.objectContaining({ actor: 'manager', projectId: PROJECT_ID, managerName: MANAGER_NAME, path: filePath, bytes: 5 }) }]);
  });

  it('is allowed for a child of the manager and journaled as a child', async () => {
    await bootDaemon();
    const manager = await createManager();
    const child = await createChildOf(manager.id);
    const filePath = join(managerDirectoryOf(), 'notes', 'x.md');

    const answer = await write(child.id, filePath, 'hi');

    expect(decisionOf(answer)).toBe('allow');
    expect(journalRows()).toEqual([{ sessionId: child.id, kind: 'artifact_write', payload: expect.objectContaining({ actor: 'child', path: filePath }) }]);
  });

  it('is allowed for a grandchild of the manager', async () => {
    await bootDaemon();
    const manager = await createManager();
    const child = await createChildOf(manager.id);
    const grandchild = await createChildOf(child.id);

    const answer = await write(grandchild.id, join(managerDirectoryOf(), 'x.md'), 'hi');

    expect(decisionOf(answer)).toBe('allow');
  });

  it('is journaled with the agent id when a sub-agent writes', async () => {
    await bootDaemon();
    const manager = await createManager();
    const child = await createChildOf(manager.id);

    await write(child.id, join(managerDirectoryOf(), 'x.md'), 'hi', { agent_id: 'agent-7', agent_type: 'general' });

    expect(journalRows()[0]?.payload).toMatchObject({ actor: 'child', agentId: 'agent-7' });
  });

  it('finds the directory created by the daemon under <docs folder>/artifacts/<manager>', async () => {
    await bootDaemon();
    const manager = await createManager();

    await write(manager.id, join(managerDirectoryOf(), 'a.md'), 'hello');

    expect(isDirectory(managerDirectoryOf())).toBe(true);
  });
});

describe('a Write the artifact directory does not vouch for', () => {
  it('is left to the normal flow when it targets the docs folder outside artifacts', async () => {
    await bootDaemon();
    const manager = await createManager();

    const answer = await write(manager.id, join(docsFolder, 'specs', 'x.md'), 'hi');

    expect(answer).toEqual({});
    expect(journalRows()).toEqual([]);
  });

  it('is left to the normal flow when it targets the directory of another manager', async () => {
    await bootDaemon();
    const manager = await createManager();
    mkdirSync(managerDirectoryOf('Other'), { recursive: true });

    const answer = await write(manager.id, join(managerDirectoryOf('Other'), 'x.md'), 'hi');

    expect(answer).toEqual({});
    expect(journalRows()).toEqual([]);
  });

  it('is left to the normal flow for a session no manager runs', async () => {
    await bootDaemon();
    const loneSession = await createSession({ name: MANAGER_NAME, projectId: PROJECT_ID });

    const answer = await write(loneSession.id, join(managerDirectoryOf(), 'x.md'), 'hi');

    expect(answer).toEqual({});
    expect(journalRows()).toEqual([]);
  });

  it('is left to the normal flow for a manager whose project has no docs folder', async () => {
    await bootDaemon();
    const manager = await createManager({ projectId: PROJECT_WITHOUT_DOCS_FOLDER_ID });

    const answer = await write(manager.id, join(managerDirectoryOf(), 'x.md'), 'hi');

    expect(answer).toEqual({});
  });

  it('is left to the normal flow for a manager without a project', async () => {
    await bootDaemon();
    const manager = await createSession({ name: MANAGER_NAME, manager: { childrenCap: 2, mission: 'Ship the thing' } });

    const answer = await write(manager.id, join(managerDirectoryOf(), 'x.md'), 'hi');

    expect(answer).toEqual({});
  });

  it('is left to the normal flow when the docs folder is gone, the judge failing without allowing', async () => {
    await bootDaemon();
    const manager = await createManager();
    daemon!.db.prepare('UPDATE projects SET docs_folder_path = ? WHERE id = ?').run(join(docsFolder, 'vanished'), PROJECT_ID);

    const answer = await write(manager.id, join(managerDirectoryOf(), 'x.md'), 'hi');

    expect(answer).toEqual({});
  });
});

describe('a Write refused inside the artifact directory', () => {
  it('is denied when the path climbs out with .. and journaled as refused', async () => {
    await bootDaemon();
    const manager = await createManager();

    const answer = await write(manager.id, `${managerDirectoryOf()}/../../specs/x.md`, 'hi');

    expect(decisionOf(answer)).toBe('deny');
    expect(journalRows()).toEqual([{ sessionId: manager.id, kind: 'artifact_write_refused', payload: expect.objectContaining({ actor: 'manager', reason: expect.any(String) }) }]);
  });

  it('is denied when the path holds a NUL', async () => {
    await bootDaemon();
    const manager = await createManager();

    const answer = await write(manager.id, `${managerDirectoryOf()}/x\0.md`, 'hi');

    expect(decisionOf(answer)).toBe('deny');
  });

  it('is denied when a symbolic link inside the directory leaves it', async () => {
    await bootDaemon();
    const manager = await createManager();
    await write(manager.id, join(managerDirectoryOf(), 'seed.md'), 'x');
    const outside = tempDirs.make('of-daemon-artifacts-outside-');
    symlinkSync(outside, join(managerDirectoryOf(), 'link'));

    const answer = await write(manager.id, join(managerDirectoryOf(), 'link', 'x.md'), 'hi');

    expect(decisionOf(answer)).toBe('deny');
    expect(journalRows().at(-1)?.kind).toBe('artifact_write_refused');
  });

  it('is denied when the file is above the maximum size, and journaled', async () => {
    await bootDaemon({ configJson: SMALL_LIMITS });
    const manager = await createManager();

    const answer = await write(manager.id, join(managerDirectoryOf(), 'big.md'), 'x'.repeat(41));

    expect(decisionOf(answer)).toBe('deny');
    expect(journalRows()).toEqual([expect.objectContaining({ kind: 'artifact_write_refused', payload: expect.objectContaining({ reason: expect.stringContaining('40') }) })]);
  });

  it('is denied when it pushes the project over its quota, the files of the other managers counted', async () => {
    await bootDaemon({ configJson: SMALL_LIMITS });
    const manager = await createManager();
    mkdirSync(managerDirectoryOf('Other'), { recursive: true });
    writeFileSync(join(managerDirectoryOf('Other'), 'a.md'), 'x'.repeat(80));

    const answer = await write(manager.id, join(managerDirectoryOf(), 'b.md'), 'y'.repeat(30));

    expect(decisionOf(answer)).toBe('deny');
    expect(journalRows()).toEqual([expect.objectContaining({ kind: 'artifact_write_refused', payload: expect.objectContaining({ reason: expect.stringContaining('quota') }) })]);
  });

  it('is denied for a manager name that tries to climb out, the directory staying under artifacts', async () => {
    await bootDaemon();
    const manager = await createManager({ name: '../../escape' });

    const answer = await write(manager.id, join(docsFolder, 'artifacts', 'escape', 'x.md'), 'hi');

    expect(decisionOf(answer)).toBe('allow');
    expect(isDirectory(join(docsFolder, 'escape'))).toBe(false);
    expect(isDirectory(join(docsFolder, '..', 'escape'))).toBe(false);
  });

  it('keeps the policy refusal of a write into a .git directory, whatever the artifact directory says', async () => {
    await bootDaemon();
    const manager = await createManager();
    const child = await createChildOf(manager.id);

    const answer = await write(child.id, join(managerDirectoryOf(), '.git', 'config'), 'hi');

    expect(decisionOf(answer)).toBe('deny');
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain('no-write-into-git-dir');
    expect(journalRows()).toEqual([]);
  });
});

describe('a Write a policy rule asks about', () => {
  it('stays with the approval flow for the manager: the artifact directory grants nothing over an ask rule', async () => {
    await bootDaemon({ policyDocument: policyAskingBeforeWrites() });
    const manager = await createManager();

    const answer = await write(manager.id, join(managerDirectoryOf(), 'x.md'), 'hi');

    expect(answer).toEqual({});
    expect(journalRows()).toEqual([]);
  });

  it('stays refused for an unattended child, never allowed by the artifact directory', async () => {
    await bootDaemon({ policyDocument: policyAskingBeforeWrites() });
    const manager = await createManager();
    const child = await createChildOf(manager.id);

    const answer = await write(child.id, join(managerDirectoryOf(), 'x.md'), 'hi');

    expect(decisionOf(answer)).toBe('deny');
    expect(journalRows()).toEqual([]);
  });
});

describe('a Write a policy rule only observes', () => {
  it('journals the observed refusal and is not vouched for by the artifact directory', async () => {
    await bootDaemon({ policyDocument: policyObservingEveryRule() });
    const manager = await createManager();
    const child = await createChildOf(manager.id);

    const answer = await write(child.id, join(managerDirectoryOf(), '.git', 'hooks', 'x'), 'hi');

    expect(answer).toEqual({});
    expect(journalRows()).toEqual([]);
    await vi.waitFor(() => expect(denialRows()).toEqual([{ rule_id: 'no-write-into-git-dir', outcome: 'observed', tool_name: 'Write' }]));
  });
});

describe('the permissions the artifact directory does not widen', () => {
  const insideTheDirectory = () => join(managerDirectoryOf(), 'x.md');

  it.each(['Edit', 'MultiEdit', 'NotebookEdit', 'Read', 'Bash'])('leaves a %s call on a path of the directory to the normal flow', async (toolName) => {
    await bootDaemon();
    const manager = await createManager();
    const toolInput = { file_path: insideTheDirectory(), notebook_path: insideTheDirectory(), content: 'hi', old_string: 'a', new_string: 'b', command: `echo hi > ${insideTheDirectory()}` };

    const answer = await preToolUse(manager.id, { tool_name: toolName, tool_input: toolInput });

    expect(answer).toEqual({});
    expect(journalRows()).toEqual([]);
  });

  it('leaves a Write without a string content to a refusal, never to an allow', async () => {
    await bootDaemon();
    const manager = await createManager();

    const answer = await preToolUse(manager.id, { tool_name: 'Write', tool_input: { file_path: insideTheDirectory() } });

    expect(decisionOf(answer)).toBe('deny');
  });

  it('leaves a Write whose file_path is not a string to the normal flow', async () => {
    await bootDaemon();
    const manager = await createManager();

    const answer = await preToolUse(manager.id, { tool_name: 'Write', tool_input: { file_path: 42, content: 'hi' } });

    expect(answer).toEqual({});
  });

  it('leaves a PermissionRequest for a Write in the directory to the approval flow, which waits for a human', async () => {
    await bootDaemon();
    const manager = await createManager();
    const abort = new AbortController();

    void fetch(`${daemon!.server.url}/hooks/${hookTokenOf(manager.id)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: abort.signal,
      body: JSON.stringify({ session_id: 'cli-1', cwd: '/tmp', hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: insideTheDirectory(), content: 'hi' } }),
    }).catch(() => undefined);

    await vi.waitFor(async () => expect(await (await api('/api/approvals')).json()).toHaveLength(1));
    abort.abort();
    expect(journalRows()).toEqual([]);
  });
});
