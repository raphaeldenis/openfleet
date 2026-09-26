import { HOOK_EVENT_NAMES } from '@openfleet/shared';
import type { HarnessLaunch } from '../harness.js';

const HOOK_TIMEOUT_SECONDS = 600;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClaudeLaunchConfig {
  command: 'claude';
  args: string[];
  settings: Record<string, unknown>;
  mcpConfig: Record<string, unknown>;
}

export function buildClaudeLaunchConfig(launch: HarnessLaunch): ClaudeLaunchConfig {
  // --resume takes an optional value: a missing or non-UUID session id makes the CLI fall back to its
  // interactive picker, which would hang forever inside a PTY nothing is watching.
  if (launch.resuming && !UUID_PATTERN.test(launch.sessionId)) {
    throw new Error(`cannot resume with a missing or non-UUID session id: "${launch.sessionId}"`);
  }
  const settings = { hooks: buildHooks(launch.hookUrl) };
  const mcpConfig = {
    mcpServers: {
      openfleet: { type: 'http', url: launch.mcpUrl, headers: { Authorization: `Bearer ${launch.mcpToken}` } },
    },
  };
  // A resume reattaches to a UUID the CLI already knows: --session-id, --name
  // and the seeded prompt are first-run-only flags the CLI rejects or ignores
  // on --resume. --model is passed on both paths — `claude --help` documents
  // no conflict with --resume, and the CLI's own transcript-based model
  // restore has decline paths that could silently drop the operator's choice.
  const resumeArgs = ['--resume', launch.sessionId];
  const firstRunArgs = ['--session-id', launch.sessionId, '--name', launch.displayName];
  const args = launch.resuming ? resumeArgs : firstRunArgs;
  if (launch.model) args.push('--model', launch.model);
  if (!launch.resuming && launch.seededPrompt) args.push(launch.seededPrompt);
  if (launch.permissionMode) args.push('--permission-mode', launch.permissionMode);
  // The positional prompt must come before --mcp-config: that flag is
  // variadic ("<configs...>") and greedily swallows every following
  // non-flag argument, including a trailing prompt, as another config value.
  args.push('--settings', JSON.stringify(settings), '--mcp-config', JSON.stringify(mcpConfig));
  return { command: 'claude', args, settings, mcpConfig };
}

function buildHooks(hookUrl: string): Record<string, unknown> {
  const httpHookEntry = [{ hooks: [{ type: 'http', url: hookUrl, timeout: HOOK_TIMEOUT_SECONDS }] }];
  const sessionStartHookEntry = [{ hooks: [{ type: 'command', command: forwardStdinToHookUrl(hookUrl), timeout: HOOK_TIMEOUT_SECONDS }] }];
  return Object.fromEntries(HOOK_EVENT_NAMES.map((name) => [name, name === 'SessionStart' ? sessionStartHookEntry : httpHookEntry]));
}

// ponytail: Claude Code 2.1.281 silently drops `type: "http"` hooks for SessionStart only (confirmed with
// --debug: "HTTP hooks are not supported for SessionStart"); every other event still arrives over HTTP.
// A command hook that forwards its own stdin to the same URL works around it. hookUrl is daemon-built from
// a base64url token (no shell metacharacters), so single-quoting it is enough. Drop this once the CLI
// delivers SessionStart over http like the rest of the hook events.
function forwardStdinToHookUrl(hookUrl: string): string {
  return `curl -sS -X POST -H 'Content-Type: application/json' --data-binary @- '${hookUrl}'`;
}
