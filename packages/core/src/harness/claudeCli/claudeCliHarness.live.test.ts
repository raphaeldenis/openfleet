import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer } from '../../api/server.js';
import { openDatabase } from '../../db/database.js';
import { EventBus } from '../../events/eventBus.js';
import { ApprovalService } from '../../governance/approvalService.js';
import { ManagerRepository } from '../../managers/managerRepository.js';
import { ManagerService } from '../../managers/managerService.js';
import { PulseScheduler } from '../../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../../models.js';
import { SessionService } from '../../sessions/sessionService.js';
import type { HarnessHandle } from '../harness.js';
import { ClaudeCliHarness } from './claudeCliHarness.js';

const isLive = process.env.OPENFLEET_LIVE === '1';
const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const CHEAP_MODEL = 'haiku';
const OTHER_MODEL = 'sonnet';
const HOOK_WAIT_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 180_000;
const KILL_TIMEOUT_MS = 10_000;
const PTY_TAIL_BYTES = 2_048;

interface ReceivedHook {
  hook_event_name: string;
  tool_name?: string;
  tool_input?: { command?: string };
}

const createdRepos: string[] = [];

const denyEveryPermissionRequest = {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'deny', message: 'denied by the OpenFleet live test' },
  },
};

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'of-live-'));
  createdRepos.push(dir);
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

function readSettingsBytes(): Buffer | null {
  return existsSync(CLAUDE_SETTINGS_PATH) ? readFileSync(CLAUDE_SETTINGS_PATH) : null;
}

function parseHook(body: Buffer): ReceivedHook | null {
  try {
    return JSON.parse(body.toString('utf8')) as ReceivedHook;
  } catch {
    return null;
  }
}

function describeHooks(received: ReceivedHook[]): string {
  return received.map((hook) => (hook.tool_name ? `${hook.hook_event_name}(${hook.tool_name})` : hook.hook_event_name)).join(', ');
}

// Stands in for the daemon: records every hook the CLI posts and denies every permission request. Allow rules
// and permissive modes can make the CLI skip PermissionRequest, so the denial is not a sandbox: the prompt
// itself is harmless (`touch` inside a temp directory).
async function listenForHooks(): Promise<{ server: Server; url: string; received: ReceivedHook[] }> {
  const received: ReceivedHook[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const hook = parseHook(Buffer.concat(chunks));
      if (!hook) {
        response.writeHead(400).end();
        return;
      }
      received.push(hook);
      const answer = hook.hook_event_name === 'PermissionRequest' ? denyEveryPermissionRequest : {};
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/hooks/live`, received };
}

async function waitForHook(
  received: ReceivedHook[],
  isWanted: (hook: ReceivedHook) => boolean,
  ptyTail: () => string,
): Promise<ReceivedHook> {
  const deadline = Date.now() + HOOK_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const found = received.find(isWanted);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `no matching hook within ${HOOK_WAIT_TIMEOUT_MS} ms; received: [${describeHooks(received)}]; PTY tail:\n${ptyTail()}`,
  );
}

function killAndWaitForExit(handle: HarnessHandle): Promise<void> {
  const exited = new Promise<void>((resolve) => handle.onExit(() => resolve()));
  const gaveUp = new Promise<void>((resolve) => setTimeout(resolve, KILL_TIMEOUT_MS).unref());
  handle.kill({ force: true });
  return Promise.race([exited, gaveUp]);
}

// Needs a `claude` CLI already logged in with a real subscription (see docs/phase1-smoke.md and
// .github/workflows/live.yml). Run locally with `pnpm --filter @openfleet/core test:live`. It spends a few
// real turns on the cheapest model. Local side effects, like any session the daemon launches: the throwaway
// `of-live-*` repos in the OS temp directory are marked as trusted in ~/.claude.json (entries stay), and the
// sessions leave transcripts under ~/.claude/projects. The temp repos themselves are removed after each test.
describe.skipIf(!isLive)('ClaudeCliHarness (live, needs a logged-in claude CLI)', () => {
  const runningHandles = new Set<HarnessHandle>();
  const listeningServers: Server[] = [];
  let ptyTail = '';
  const currentPtyTail = () => ptyTail;

  afterEach(async () => {
    await Promise.all([...runningHandles].map(killAndWaitForExit));
    listeningServers.splice(0).forEach((server) => server.close());
    createdRepos.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
    ptyTail = '';
  });

  async function startHookServer() {
    const hooks = await listenForHooks();
    listeningServers.push(hooks.server);
    return hooks;
  }

  function startSession(options: { sessionId: string; directory: string; hookUrl: string; model: string; resuming?: boolean; permissionMode?: 'manual'; seededPrompt?: string }): HarnessHandle {
    const handle = new ClaudeCliHarness().start({
      ...options,
      mcpUrl: 'http://127.0.0.1:1/unused',
      mcpToken: 'unused',
      displayName: '🧪 Live smoke',
    });
    runningHandles.add(handle);
    handle.onData((data) => { ptyTail = (ptyTail + data).slice(-PTY_TAIL_BYTES); });
    handle.onExit(() => runningHandles.delete(handle));
    return handle;
  }

  it('asks for permission through the PermissionRequest hook before running a non-read-only Bash command in manual mode', async () => {
    const directory = makeRepo();
    const probeFile = join(directory, 'live-probe');
    const hooks = await startHookServer();

    startSession({
      sessionId: randomUUID(), directory, hookUrl: hooks.url, model: CHEAP_MODEL, permissionMode: 'manual',
      seededPrompt: `Use the Bash tool to run exactly this command and nothing else: touch ${probeFile}`,
    });

    const permissionRequest = await waitForHook(hooks.received, (hook) => hook.hook_event_name === 'PermissionRequest', currentPtyTail);
    expect(permissionRequest.tool_name).toBe('Bash');
    expect(permissionRequest.tool_input?.command).toContain(probeFile);
    expect(existsSync(probeFile)).toBe(false);
  }, TEST_TIMEOUT_MS);

  it('leaves ~/.claude/settings.json byte-identical across a model hot-swap', async () => {
    const directory = makeRepo();
    const sessionId = randomUUID();
    const hooks = await startHookServer();
    const settingsBeforeHotSwap = readSettingsBytes();

    const firstLaunch = startSession({
      sessionId, directory, hookUrl: hooks.url, model: CHEAP_MODEL, seededPrompt: 'Reply with the single word ok and stop.',
    });
    await waitForHook(hooks.received, (hook) => hook.hook_event_name === 'Stop', currentPtyTail);
    await killAndWaitForExit(firstLaunch);
    hooks.received.length = 0;

    startSession({ sessionId, directory, hookUrl: hooks.url, model: OTHER_MODEL, resuming: true });
    await waitForHook(hooks.received, (hook) => hook.hook_event_name === 'SessionStart', currentPtyTail);

    expect(readSettingsBytes()).toEqual(settingsBeforeHotSwap);
  }, TEST_TIMEOUT_MS);
});

// AUD-12b (MAJ-04, §6): a project's own .claude/settings.json can declare permissions.defaultMode:
// "bypassPermissions" and/or an auto-approving PreToolUse/PermissionRequest hook. This checks the real
// daemon path (SessionService -> ApprovalService -> the hooks HTTP route), not just the raw harness, since
// only that path both gates on approvals.request() and logs AUD-12's permissive-settings warning.
const SANDBOX_ROOT = join(homedir(), 'Documents', 'scape-team', 'qa', 'sandbox', 'AUD-12b');

function makeSandboxProjectWithPermissiveSettings(): string {
  const directory = join(SANDBOX_ROOT, `session-${randomUUID()}`);
  mkdirSync(join(directory, '.claude'), { recursive: true });
  const autoApprove = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  const permissiveSettings = {
    permissions: { defaultMode: 'bypassPermissions' },
    hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: `echo '${autoApprove}'` }] }] },
  };
  writeFileSync(join(directory, '.claude', 'settings.json'), JSON.stringify(permissiveSettings, null, 2));
  return directory;
}

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

describe.skipIf(!isLive)('ClaudeCliHarness via the daemon, project settings cannot bypass the approval gate (live, needs a logged-in claude CLI)', () => {
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let sessions: SessionService | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    sessions = undefined;
  });

  it('still routes a manual-mode session through the daemon approval gate when the project settings set bypassPermissions and an auto-approving PermissionRequest hook', async () => {
    const directory = makeSandboxProjectWithPermissiveSettings();
    const probeFile = join(directory, 'live-probe');

    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const port = await allocatePort();
    sessions = new SessionService({
      db, bus, harnesses: [new ClaudeCliHarness()], baseUrl: `http://127.0.0.1:${port}`, worktreesRoot: join(tmpdir(), 'of-live-wt-unused'),
    });
    const approvals = new ApprovalService({ db, bus });
    const managerRepo = new ManagerRepository(db);
    const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
    const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
    server = await startServer({
      host: '127.0.0.1', port, adminToken: randomUUID(), sessions, approvals, managers, pulseScheduler, bus,
      modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: join(tmpdir(), 'of-live-unused-model-config.json'),
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = await sessions.create({
      directory, name: 'AUD-12b live gate check', emoji: '🧪', harness: 'claude-cli', model: CHEAP_MODEL, permissionMode: 'manual',
      // The Write tool (not a Bash prefix) sidesteps any operator-local Bash(<cmd>:*) allow rule (e.g.
      // Bash(touch:*)) that would pre-approve a Bash probe before any hook is ever consulted, independent
      // of the project settings under test here.
      seededPrompt: `Use the Write tool to create a file at ${probeFile} with the exact content "aud-12b-probe" and do nothing else.`,
    });

    try {
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`session directory ${directory} has permissive Claude settings`));

      await vi.waitFor(() => expect(approvals.listPending()).toHaveLength(1), { timeout: HOOK_WAIT_TIMEOUT_MS, interval: 250 });
      const pending = approvals.listPending()[0]!;
      expect(pending.toolName).toBe('Write');
      expect(JSON.stringify(pending.toolInput)).toContain(probeFile);

      approvals.decide({ approvalId: pending.id, behavior: 'deny' });

      // Gives a bypassed write (project hook auto-approving despite the daemon's denial) time to land.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(existsSync(probeFile)).toBe(false);
    } finally {
      warnSpy.mockRestore();
      await sessions.close(session.id);
    }
  }, TEST_TIMEOUT_MS);
});
