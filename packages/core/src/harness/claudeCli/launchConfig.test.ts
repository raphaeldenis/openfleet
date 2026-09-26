import { PERMISSION_MODES } from '@openfleet/shared';
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

  it('registers an http hook for every tracked event but SessionStart, pointing at hookUrl', () => {
    const { settings } = buildClaudeLaunchConfig(launch);
    const hooks = settings.hooks as Record<string, { hooks: { type: string; url: string }[] }[]>;
    for (const name of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SessionEnd']) {
      expect(hooks[name]?.[0]?.hooks[0]).toEqual({ type: 'http', url: launch.hookUrl, timeout: 600 });
    }
  });

  it('registers SessionStart as a command hook forwarding its stdin to the same hook URL, since the CLI silently drops http hooks for that event', () => {
    const { settings } = buildClaudeLaunchConfig(launch);
    const hooks = settings.hooks as Record<string, { hooks: { type: string; command?: string; url?: string }[] }[]>;
    const sessionStartHook = hooks.SessionStart?.[0]?.hooks[0]!;
    expect(sessionStartHook.type).toBe('command');
    expect(sessionStartHook.url).toBeUndefined();
    expect(sessionStartHook.command).toContain(launch.hookUrl);
    expect(sessionStartHook.command).toContain('--data-binary @-');
  });

  it('single-quotes the hook URL in the SessionStart command and never interpolates the session directory or seeded prompt', () => {
    const dangerousLaunch = {
      ...launch,
      hookUrl: 'http://127.0.0.1:7331/hooks/abcDEF123-_xyz',
      directory: "/tmp/wt with a space and a ' quote",
      seededPrompt: "'; rm -rf / #",
    };
    const { settings } = buildClaudeLaunchConfig(dangerousLaunch);
    const hooks = settings.hooks as Record<string, { hooks: { type: string; command?: string }[] }[]>;
    const command = hooks.SessionStart?.[0]?.hooks[0]!.command!;

    expect(command).toBe(`curl -sS --connect-timeout 2 --max-time 10 -X POST -H 'Content-Type: application/json' --data-binary @- '${dangerousLaunch.hookUrl}'`);
    expect(command).not.toContain(dangerousLaunch.directory);
    expect(command).not.toContain(dangerousLaunch.seededPrompt);
  });

  it('gives the SessionStart command hook the same timeout as every other hook, so a stalled forward does not hang the CLI indefinitely', () => {
    const { settings } = buildClaudeLaunchConfig(launch);
    const hooks = settings.hooks as Record<string, { hooks: { timeout: number }[] }[]>;
    expect(hooks.SessionStart?.[0]?.hooks[0]!.timeout).toBe(hooks.Stop?.[0]?.hooks[0]!.timeout);
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

  it.each(PERMISSION_MODES)('passes --permission-mode %s on a first run, exactly the documented CLI choice', (mode) => {
    const config = buildClaudeLaunchConfig({ ...launch, permissionMode: mode });
    const flagIndex = config.args.indexOf('--permission-mode');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(config.args[flagIndex + 1]).toBe(mode);
  });

  it.each(PERMISSION_MODES)('passes --permission-mode %s on resume too, after --resume <id>', (mode) => {
    const config = buildClaudeLaunchConfig({ ...launch, resuming: true, permissionMode: mode });
    const resumeIndex = config.args.indexOf('--resume');
    const flagIndex = config.args.indexOf('--permission-mode');
    expect(flagIndex).toBeGreaterThan(resumeIndex);
    expect(config.args[flagIndex + 1]).toBe(mode);
  });

  it('omits --permission-mode entirely when none is given, so the CLI keeps the user default', () => {
    const config = buildClaudeLaunchConfig(launch);
    expect(config.args).not.toContain('--permission-mode');
  });

  it('refuses to resume with an empty session id, so the CLI never opens its interactive picker inside the PTY', () => {
    expect(() => buildClaudeLaunchConfig({ ...launch, resuming: true, sessionId: '' })).toThrow();
  });

  it('refuses to resume with a non-UUID session id, so the CLI never opens its interactive picker inside the PTY', () => {
    expect(() => buildClaudeLaunchConfig({ ...launch, resuming: true, sessionId: 'not-a-uuid' })).toThrow();
  });

  it('accepts an uppercase UUID on resume, since --resume is case-insensitive', () => {
    // Must contain a-f letters, or .toUpperCase() is a no-op and the assertion below proves nothing.
    const lowercaseWithLetters = 'ab12cd34-5678-4abc-8def-abcdef123456';
    const uppercase = lowercaseWithLetters.toUpperCase();
    expect(() => buildClaudeLaunchConfig({ ...launch, resuming: true, sessionId: uppercase })).not.toThrow();
    const config = buildClaudeLaunchConfig({ ...launch, resuming: true, sessionId: uppercase });
    expect(config.args.slice(0, 2)).toEqual(['--resume', uppercase]);
  });

  it('does not guard a first-run (non-resuming) launch against a non-UUID session id — only resume is guarded', () => {
    expect(() => buildClaudeLaunchConfig({ ...launch, resuming: false, sessionId: 'not-a-uuid' })).not.toThrow();
    expect(() => buildClaudeLaunchConfig({ ...launch, sessionId: '' })).not.toThrow();
  });

  it('resuming a session passes --resume <id> and drops --session-id, --name and the prompt', () => {
    const config = buildClaudeLaunchConfig({ ...launch, resuming: true });
    expect(config.args.slice(0, 2)).toEqual(['--resume', launch.sessionId]);
    expect(config.args).not.toContain('--session-id');
    expect(config.args).not.toContain('--name');
    expect(config.args).not.toContain(launch.displayName);
  });

  it('resuming a session keeps --model when the session has one', () => {
    const config = buildClaudeLaunchConfig({ ...launch, resuming: true });
    const flagIndex = config.args.indexOf('--model');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(config.args[flagIndex + 1]).toBe(launch.model);
  });

  it('resuming still carries --settings and --mcp-config, so the same daemon hooks apply', () => {
    const config = buildClaudeLaunchConfig({ ...launch, resuming: true });
    expect(config.args.indexOf('--settings')).toBeGreaterThan(-1);
    expect(config.args.indexOf('--mcp-config')).toBeGreaterThan(-1);
  });

  it('includes the seeded prompt and keeps --permission-mode before --mcp-config on a first run', () => {
    const config = buildClaudeLaunchConfig({ ...launch, seededPrompt: 'Say hello and stop.', permissionMode: 'acceptEdits' });
    const promptIndex = config.args.indexOf('Say hello and stop.');
    const permissionModeIndex = config.args.indexOf('--permission-mode');
    const mcpConfigIndex = config.args.indexOf('--mcp-config');
    expect(promptIndex).toBeGreaterThan(-1);
    expect(permissionModeIndex).toBeLessThan(mcpConfigIndex);
  });

  it('resuming with a seeded prompt drops the prompt, so it is never swallowed by --mcp-config nor rejected by --resume', () => {
    const config = buildClaudeLaunchConfig({ ...launch, resuming: true, seededPrompt: 'Say hello and stop.' });
    expect(config.args).not.toContain('Say hello and stop.');
  });

  it('resuming with a permission mode still passes --permission-mode after --resume <id>', () => {
    const config = buildClaudeLaunchConfig({ ...launch, resuming: true, permissionMode: 'acceptEdits' });
    const resumeIndex = config.args.indexOf('--resume');
    const flagIndex = config.args.indexOf('--permission-mode');
    expect(flagIndex).toBeGreaterThan(resumeIndex);
    expect(config.args[flagIndex + 1]).toBe('acceptEdits');
  });

  it('never repeats --settings or --mcp-config on a first run', () => {
    const config = buildClaudeLaunchConfig(launch);
    expect(config.args.filter((arg) => arg === '--settings')).toHaveLength(1);
    expect(config.args.filter((arg) => arg === '--mcp-config')).toHaveLength(1);
  });

  it('never repeats --settings or --mcp-config while resuming', () => {
    const config = buildClaudeLaunchConfig({ ...launch, resuming: true });
    expect(config.args.filter((arg) => arg === '--settings')).toHaveLength(1);
    expect(config.args.filter((arg) => arg === '--mcp-config')).toHaveLength(1);
  });

  it('returns the same settings and mcp config whether the launch resumes or starts fresh, so daemon hooks and tokens do not drift on resume', () => {
    const firstRun = buildClaudeLaunchConfig(launch);
    const resumed = buildClaudeLaunchConfig({ ...launch, resuming: true });
    expect(resumed.settings).toEqual(firstRun.settings);
    expect(resumed.mcpConfig).toEqual(firstRun.mcpConfig);
  });
});
