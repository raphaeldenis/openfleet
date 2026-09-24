import { describe, expect, it } from 'vitest';
import { buildClaudeLaunchConfig } from './launchConfig.js';

const launch = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  directory: '/tmp/wt',
  model: 'claude-sonnet-5',
  hookUrl: 'http://127.0.0.1:7331/hooks/tok-hook',
  mcpUrl: 'http://127.0.0.1:7331/mcp',
  mcpToken: 'tok-mcp',
  displayName: '⚔️ Gimli - CCM-1',
};

describe('buildClaudeLaunchConfig', () => {
  it('passes model, name, session id, settings and mcp config as args', () => {
    const config = buildClaudeLaunchConfig(launch);
    expect(config.command).toBe('claude');
    expect(config.args).toEqual(expect.arrayContaining(['--model', 'claude-sonnet-5', '--name', launch.displayName, '--session-id', launch.sessionId]));
    expect(config.args.indexOf('--settings')).toBeGreaterThan(-1);
    expect(config.args.indexOf('--mcp-config')).toBeGreaterThan(-1);
  });

  it('registers an http hook for every tracked event pointing at hookUrl', () => {
    const { settings } = buildClaudeLaunchConfig(launch);
    const hooks = settings.hooks as Record<string, { hooks: { type: string; url: string }[] }[]>;
    for (const name of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SessionEnd']) {
      expect(hooks[name]?.[0]?.hooks[0]).toEqual({ type: 'http', url: launch.hookUrl, timeout: 600 });
    }
  });

  it('configures the openfleet MCP server with the bearer token', () => {
    const { mcpConfig } = buildClaudeLaunchConfig(launch);
    expect(mcpConfig).toEqual({ mcpServers: { openfleet: { type: 'http', url: launch.mcpUrl, headers: { Authorization: 'Bearer tok-mcp' } } } });
  });

  it('places the seeded prompt before --mcp-config so the CLI does not swallow it as a config value', () => {
    const config = buildClaudeLaunchConfig({ ...launch, seededPrompt: 'Say hello and stop.' });
    const promptIndex = config.args.indexOf('Say hello and stop.');
    expect(promptIndex).toBeGreaterThan(-1);
    expect(promptIndex).toBeLessThan(config.args.indexOf('--mcp-config'));
  });
});
