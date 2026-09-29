import { HOOK_EVENT_NAMES, isValidModelId } from '@openfleet/shared';
import type { HarnessLaunch } from '../harness.js';
import type { TokenFilePaths } from './tokenFiles.js';

const HOOK_TIMEOUT_SECONDS = 600;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClaudeLaunchConfig {
  command: 'claude';
  args: string[];
  settings: Record<string, unknown>;
  mcpConfig: Record<string, unknown>;
  hookCurlConfig: string;
}

// tokenFilePaths are where the caller will write `settings` and `mcpConfig` on disk (0600, inside a 0700
// per-session directory) — this function only ever puts those *paths* in argv, never the JSON itself, so
// the session hook token and the MCP bearer never appear in `ps` output (AUD-11).
export function buildClaudeLaunchConfig(launch: HarnessLaunch, tokenFilePaths: TokenFilePaths): ClaudeLaunchConfig {
  // --resume takes an optional value: a missing or non-UUID session id makes the CLI fall back to its
  // interactive picker, which would hang forever inside a PTY nothing is watching.
  const conversationId = launch.cliSessionId ?? launch.sessionId;
  if (launch.resuming && !UUID_PATTERN.test(conversationId)) {
    throw new Error(`cannot resume with a missing or non-UUID session id: "${conversationId}"`);
  }
  // Defence in depth: every REST/MCP entry validates a model id before it reaches here, but --model takes
  // this value directly, and a value starting with '-' or containing whitespace would be read as another
  // CLI flag instead.
  if (launch.model !== undefined && !isValidModelId(launch.model)) {
    throw new Error(`refusing to launch with an invalid model id: "${launch.model}"`);
  }
  const settings = { hooks: buildHooks(launch.hookUrl, tokenFilePaths.hookCurlConfigPath) };
  const mcpConfig = {
    mcpServers: {
      openfleet: { type: 'http', url: launch.mcpUrl, headers: { Authorization: `Bearer ${launch.mcpToken}` } },
    },
  };
  // curl's -K config format for a long option: `name = "value"` (double-quoted, since the URL contains
  // no double quote of its own). Read by forwardStdinToHookUrl below instead of the URL going into argv.
  const hookCurlConfig = `url = "${launch.hookUrl}"`;
  // A resume reattaches to a UUID the CLI already knows: --session-id, --name
  // and the seeded prompt are first-run-only flags the CLI rejects or ignores
  // on --resume. --model is passed on both paths — `claude --help` documents
  // no conflict with --resume, and the CLI's own transcript-based model
  // restore has decline paths that could silently drop the operator's choice.
  const resumeArgs = ['--resume', conversationId];
  const firstRunArgs = ['--session-id', conversationId, '--name', launch.displayName];
  const args = launch.resuming ? resumeArgs : firstRunArgs;
  if (launch.model) args.push('--model', launch.model);
  if (launch.permissionMode) args.push('--permission-mode', launch.permissionMode);
  // AUD-28: a project's own .claude/settings.json can define an auto-approving PermissionRequest hook that
  // overrides OpenFleet's own deny — `--setting-sources user` drops project/local/managed settings from the
  // CLI's own merge, so only OpenFleet's `--settings` file below and the user's own ~/.claude/settings.json apply.
  args.push('--setting-sources', 'user', '--settings', tokenFilePaths.settingsPath, '--mcp-config', tokenFilePaths.mcpConfigPath);
  // The seeded prompt is untrusted (session/task-provided) text. Commander parses flags
  // anywhere in argv, so a prompt like "--dangerously-skip-permissions" would otherwise be
  // read as a CLI option. `--` forces every token after it to be a positional argument, and
  // it must be the very last argv entry so nothing pushed later can land ahead of it.
  if (!launch.resuming && launch.seededPrompt) args.push('--', launch.seededPrompt);
  return { command: 'claude', args, settings, mcpConfig, hookCurlConfig };
}

function buildHooks(hookUrl: string, hookCurlConfigPath: string): Record<string, unknown> {
  const httpHookEntry = [{ hooks: [{ type: 'http', url: hookUrl, timeout: HOOK_TIMEOUT_SECONDS }] }];
  const sessionStartHookEntry = [{ hooks: [{ type: 'command', command: forwardStdinToHookUrl(hookCurlConfigPath), timeout: HOOK_TIMEOUT_SECONDS }] }];
  return Object.fromEntries(HOOK_EVENT_NAMES.map((name) => [name, name === 'SessionStart' ? sessionStartHookEntry : httpHookEntry]));
}

// ponytail: Claude Code 2.1.281 silently drops `type: "http"` hooks for SessionStart only (confirmed with
// --debug: "HTTP hooks are not supported for SessionStart"); every other event still arrives over HTTP.
// A command hook that forwards its own stdin to the same URL works around it. The URL itself lives only
// in the 0600 curl config file this command points at (AUD-11) — a bare argv URL is visible to any other
// local user via `ps`, but this path is not a secret. The timeouts keep a hung daemon from stalling the
// CLI's startup on this hook. Drop this once the CLI delivers SessionStart over http like the rest of the
// hook events.
function forwardStdinToHookUrl(hookCurlConfigPath: string): string {
  return `curl -sS --connect-timeout 2 --max-time 10 -X POST -H 'Content-Type: application/json' -K '${hookCurlConfigPath}' --data-binary @-`;
}
