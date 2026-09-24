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
  // The positional prompt must come before --mcp-config: that flag is
  // variadic ("<configs...>") and greedily swallows every following
  // non-flag argument, including a trailing prompt, as another config value.
  const args = [
    '--session-id', launch.sessionId,
    '--name', launch.displayName,
  ];
  if (launch.model) args.push('--model', launch.model);
  if (launch.seededPrompt) args.push(launch.seededPrompt);
  args.push('--settings', JSON.stringify(settings), '--mcp-config', JSON.stringify(mcpConfig));
  return { command: 'claude', args, settings, mcpConfig };
}

function buildHooks(hookUrl: string): Record<string, unknown> {
  const hookEntry = [{ hooks: [{ type: 'http', url: hookUrl, timeout: HOOK_TIMEOUT_SECONDS }] }];
  return Object.fromEntries(HOOK_EVENT_NAMES.map((name) => [name, hookEntry]));
}
