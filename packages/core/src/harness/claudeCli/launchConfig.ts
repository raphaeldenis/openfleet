import { HOOK_EVENT_NAMES } from '@openfleet/shared';
import type { HarnessLaunch } from '../harness.js';

const HOOK_TIMEOUT_SECONDS = 600;

export interface ClaudeLaunchConfig {
  command: 'claude';
  args: string[];
  settings: Record<string, unknown>;
  mcpConfig: Record<string, unknown>;
}

export function buildClaudeLaunchConfig(launch: HarnessLaunch): ClaudeLaunchConfig {
  const settings = { hooks: buildHooks(launch.hookUrl) };
  const mcpConfig = {
    mcpServers: {
      openfleet: { type: 'http', url: launch.mcpUrl, headers: { Authorization: `Bearer ${launch.mcpToken}` } },
    },
  };
  // A resume reattaches to a UUID the CLI already knows: --session-id, --name,
  // --model and the seeded prompt are first-run-only flags the CLI rejects or
  // ignores on --resume.
  const resumeArgs = ['--resume', launch.sessionId];
  const firstRunArgs = ['--session-id', launch.sessionId, '--name', launch.displayName];
  const args = launch.resuming ? resumeArgs : firstRunArgs;
  if (!launch.resuming) {
    if (launch.model) args.push('--model', launch.model);
    if (launch.seededPrompt) args.push(launch.seededPrompt);
  }
  if (launch.permissionMode) args.push('--permission-mode', launch.permissionMode);
  // The positional prompt must come before --mcp-config: that flag is
  // variadic ("<configs...>") and greedily swallows every following
  // non-flag argument, including a trailing prompt, as another config value.
  args.push('--settings', JSON.stringify(settings), '--mcp-config', JSON.stringify(mcpConfig));
  return { command: 'claude', args, settings, mcpConfig };
}

function buildHooks(hookUrl: string): Record<string, unknown> {
  const hookEntry = [{ hooks: [{ type: 'http', url: hookUrl, timeout: HOOK_TIMEOUT_SECONDS }] }];
  return Object.fromEntries(HOOK_EVENT_NAMES.map((name) => [name, hookEntry]));
}
