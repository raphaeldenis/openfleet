import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessHandle } from '../harness.js';
import { ClaudeCliHarness } from './claudeCliHarness.js';

const isLive = process.env.OPENFLEET_LIVE === '1';
const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const CHEAP_MODEL = 'haiku';
const OTHER_MODEL = 'sonnet';
const HOOK_WAIT_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 180_000;

interface ReceivedHook {
  hook_event_name: string;
  tool_name?: string;
}

const denyEveryPermissionRequest = {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'deny', message: 'denied by the OpenFleet live test' },
  },
};

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'of-live-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

function readSettingsBytes(): Buffer | null {
  return existsSync(CLAUDE_SETTINGS_PATH) ? readFileSync(CLAUDE_SETTINGS_PATH) : null;
}

// Stands in for the daemon: records every hook the CLI posts and denies every permission request, so no
// command a live model asks for ever runs.
async function listenForHooks(): Promise<{ server: Server; url: string; received: ReceivedHook[] }> {
  const received: ReceivedHook[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const hook = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ReceivedHook;
      received.push(hook);
      const answer = hook.hook_event_name === 'PermissionRequest' ? denyEveryPermissionRequest : {};
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/hooks/live`, received };
}

async function waitForHook(received: ReceivedHook[], isWanted: (hook: ReceivedHook) => boolean): Promise<ReceivedHook> {
  const deadline = Date.now() + HOOK_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const found = received.find(isWanted);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no matching hook within ${HOOK_WAIT_TIMEOUT_MS} ms; received: ${JSON.stringify(received)}`);
}

function killAndWaitForExit(handle: HarnessHandle): Promise<void> {
  return new Promise((resolve) => {
    handle.onExit(() => resolve());
    handle.kill({ force: true });
  });
}

// Needs a `claude` CLI already logged in with a real subscription (see docs/phase1-smoke.md and
// .github/workflows/live.yml). Run locally with `pnpm --filter @openfleet/core test:live`. It spends a few
// real turns on the cheapest model, and — like every session the daemon launches — marks its throwaway
// repo as trusted in ~/.claude.json.
describe.skipIf(!isLive)('ClaudeCliHarness (live, needs a logged-in claude CLI)', () => {
  const runningHandles = new Set<HarnessHandle>();
  const listeningServers: Server[] = [];

  afterEach(async () => {
    await Promise.all([...runningHandles].map(killAndWaitForExit));
    listeningServers.splice(0).forEach((server) => server.close());
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

    const permissionRequest = await waitForHook(hooks.received, (hook) => hook.hook_event_name === 'PermissionRequest');
    expect(permissionRequest.tool_name).toBe('Bash');
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
    await waitForHook(hooks.received, (hook) => hook.hook_event_name === 'Stop');
    await killAndWaitForExit(firstLaunch);
    hooks.received.length = 0;

    startSession({ sessionId, directory, hookUrl: hooks.url, model: OTHER_MODEL, resuming: true });
    await waitForHook(hooks.received, (hook) => hook.hook_event_name === 'SessionStart');

    expect(readSettingsBytes()).toEqual(settingsBeforeHotSwap);
  }, TEST_TIMEOUT_MS);
});
