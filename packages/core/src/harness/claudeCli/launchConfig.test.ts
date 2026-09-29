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

const tokenFilePaths = {
  settingsPath: '/tmp/of-sessions/s1/launch1/settings.json',
  mcpConfigPath: '/tmp/of-sessions/s1/launch1/mcp-config.json',
  hookCurlConfigPath: '/tmp/of-sessions/s1/launch1/hook-curl.conf',
};

describe('buildClaudeLaunchConfig', () => {
  it('passes model, name, session id, and the settings/mcp-config file paths as args', () => {
    const config = buildClaudeLaunchConfig(launch, tokenFilePaths);
    expect(config.command).toBe('claude');
    expect(config.args).toEqual(expect.arrayContaining(['--model', 'claude-sonnet-5', '--name', launch.displayName, '--session-id', launch.sessionId]));
    const settingsFlagIndex = config.args.indexOf('--settings');
    const mcpConfigFlagIndex = config.args.indexOf('--mcp-config');
    expect(settingsFlagIndex).toBeGreaterThan(-1);
    expect(mcpConfigFlagIndex).toBeGreaterThan(-1);
    expect(config.args[settingsFlagIndex + 1]).toBe(tokenFilePaths.settingsPath);
    expect(config.args[mcpConfigFlagIndex + 1]).toBe(tokenFilePaths.mcpConfigPath);
  });

  it('never puts the hook token or the mcp bearer token in argv — only the file paths they are written to', () => {
    const config = buildClaudeLaunchConfig(launch, tokenFilePaths);
    const argvBlob = config.args.join(' ');
    expect(argvBlob).not.toContain('tok-hook');
    expect(argvBlob).not.toContain('tok-mcp');
    expect(argvBlob).not.toContain(JSON.stringify(config.settings));
    expect(argvBlob).not.toContain(JSON.stringify(config.mcpConfig));
  });

  it('registers an http hook for every tracked event but SessionStart, pointing at hookUrl', () => {
    const { settings } = buildClaudeLaunchConfig(launch, tokenFilePaths);
    const hooks = settings.hooks as Record<string, { hooks: { type: string; url: string }[] }[]>;
    for (const name of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SessionEnd']) {
      expect(hooks[name]?.[0]?.hooks[0]).toEqual({ type: 'http', url: launch.hookUrl, timeout: 600 });
    }
  });

  it('registers SessionStart as a command hook forwarding its stdin to the hook URL via a curl config file, since the CLI silently drops http hooks for that event', () => {
    const { settings } = buildClaudeLaunchConfig(launch, tokenFilePaths);
    const hooks = settings.hooks as Record<string, { hooks: { type: string; command?: string; url?: string }[] }[]>;
    const sessionStartHook = hooks.SessionStart?.[0]?.hooks[0]!;
    expect(sessionStartHook.type).toBe('command');
    expect(sessionStartHook.url).toBeUndefined();
    expect(sessionStartHook.command).toContain(`-K '${tokenFilePaths.hookCurlConfigPath}'`);
    expect(sessionStartHook.command).toContain('--data-binary @-');
  });

  it('never puts the hook token in the SessionStart command itself — only in the curl config file a `ps` listing cannot see', () => {
    const { settings } = buildClaudeLaunchConfig(launch, tokenFilePaths);
    const hooks = settings.hooks as Record<string, { hooks: { command?: string }[] }[]>;
    const command = hooks.SessionStart?.[0]?.hooks[0]!.command!;

    expect(command).not.toContain(launch.hookUrl);
  });

  it('writes the hook URL into the curl config content, in the `url = "..."` form -K expects', () => {
    const { hookCurlConfig } = buildClaudeLaunchConfig(launch, tokenFilePaths);

    expect(hookCurlConfig).toBe(`url = "${launch.hookUrl}"`);
  });

  it('single-quotes the curl config path in the SessionStart command and never interpolates the session directory, seeded prompt, or hook URL', () => {
    const dangerousLaunch = {
      ...launch,
      hookUrl: 'http://127.0.0.1:7331/hooks/abcDEF123-_xyz',
      directory: "/tmp/wt with a space and a ' quote",
      seededPrompt: "'; rm -rf / #",
    };
    const { settings } = buildClaudeLaunchConfig(dangerousLaunch, tokenFilePaths);
    const hooks = settings.hooks as Record<string, { hooks: { type: string; command?: string }[] }[]>;
    const command = hooks.SessionStart?.[0]?.hooks[0]!.command!;

    expect(command).toBe(
      `curl -sS --connect-timeout 2 --max-time 10 -X POST -H 'Content-Type: application/json' -K '${tokenFilePaths.hookCurlConfigPath}' --data-binary @-`,
    );
    expect(command).not.toContain(dangerousLaunch.directory);
    expect(command).not.toContain(dangerousLaunch.seededPrompt);
    expect(command).not.toContain(dangerousLaunch.hookUrl);
  });

  it('gives the SessionStart command hook the same timeout as every other hook, so a stalled forward does not hang the CLI indefinitely', () => {
    const { settings } = buildClaudeLaunchConfig(launch, tokenFilePaths);
    const hooks = settings.hooks as Record<string, { hooks: { timeout: number }[] }[]>;
    expect(hooks.SessionStart?.[0]?.hooks[0]!.timeout).toBe(hooks.Stop?.[0]?.hooks[0]!.timeout);
  });

  it('configures the openfleet MCP server with the bearer token', () => {
    const { mcpConfig } = buildClaudeLaunchConfig(launch, tokenFilePaths);
    expect(mcpConfig).toEqual({ mcpServers: { openfleet: { type: 'http', url: launch.mcpUrl, headers: { Authorization: 'Bearer tok-mcp' } } } });
  });

  it('places the seeded prompt as the very last argv token, after a bare -- separator', () => {
    const config = buildClaudeLaunchConfig({ ...launch, seededPrompt: 'Say hello and stop.' }, tokenFilePaths);
    expect(config.args.slice(-2)).toEqual(['--', 'Say hello and stop.']);
  });

  it('never lets a prompt shaped like a CLI flag appear before the -- separator, on the REST-triggered shape', () => {
    const config = buildClaudeLaunchConfig({ ...launch, seededPrompt: '--dangerously-skip-permissions' }, tokenFilePaths);
    const separatorIndex = config.args.indexOf('--');
    expect(config.args.slice(separatorIndex)).toEqual(['--', '--dangerously-skip-permissions']);
    expect(config.args.slice(0, separatorIndex)).not.toContain('--dangerously-skip-permissions');
  });

  it('never lets a prompt shaped like a CLI flag appear before the -- separator, on the MCP-triggered shape', () => {
    const config = buildClaudeLaunchConfig({ ...launch, seededPrompt: '--model claude-opus-5-5' }, tokenFilePaths);
    const separatorIndex = config.args.indexOf('--');
    expect(config.args.slice(separatorIndex)).toEqual(['--', '--model claude-opus-5-5']);
    expect(config.args.slice(0, separatorIndex)).not.toContain('--model claude-opus-5-5');
  });

  it.each(PERMISSION_MODES)('passes --permission-mode %s on a first run, exactly the documented CLI choice', (mode) => {
    const config = buildClaudeLaunchConfig({ ...launch, permissionMode: mode }, tokenFilePaths);
    const flagIndex = config.args.indexOf('--permission-mode');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(config.args[flagIndex + 1]).toBe(mode);
  });

  it.each(PERMISSION_MODES)('passes --permission-mode %s on resume too, after --resume <id>', (mode) => {
    const config = buildClaudeLaunchConfig({ ...launch, resuming: true, permissionMode: mode }, tokenFilePaths);
    const resumeIndex = config.args.indexOf('--resume');
    const flagIndex = config.args.indexOf('--permission-mode');
    expect(flagIndex).toBeGreaterThan(resumeIndex);
    expect(config.args[flagIndex + 1]).toBe(mode);
  });

  it('omits --permission-mode entirely when none is given, so the CLI keeps the user default', () => {
    const config = buildClaudeLaunchConfig(launch, tokenFilePaths);
    expect(config.args).not.toContain('--permission-mode');
  });

  it.each([
    ['a flag-shaped id', '--x'],
    ['a short-flag-shaped id', '-p'],
    ['an id with a space inside', 'a b'],
    ['an id with a newline inside', 'a\nb'],
  ])('refuses to spawn with a model that is %s, in case an invalid id slipped past every REST/MCP check', (_label, model) => {
    expect(() => buildClaudeLaunchConfig({ ...launch, model }, tokenFilePaths)).toThrow();
  });

  it.each(['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-fable-5-1'])(
    'passes --model %s through for every real id in the model table',
    (model) => {
      const config = buildClaudeLaunchConfig({ ...launch, model }, tokenFilePaths);
      const flagIndex = config.args.indexOf('--model');
      expect(config.args[flagIndex + 1]).toBe(model);
    },
  );

  it('refuses to resume with an empty session id, so the CLI never opens its interactive picker inside the PTY', () => {
    expect(() => buildClaudeLaunchConfig({ ...launch, resuming: true, sessionId: '' }, tokenFilePaths)).toThrow();
  });

  it('refuses to resume with a non-UUID session id, so the CLI never opens its interactive picker inside the PTY', () => {
    expect(() => buildClaudeLaunchConfig({ ...launch, resuming: true, sessionId: 'not-a-uuid' }, tokenFilePaths)).toThrow();
  });

  it('accepts an uppercase UUID on resume, since --resume is case-insensitive', () => {
    // Must contain a-f letters, or .toUpperCase() is a no-op and the assertion below proves nothing.
    const lowercaseWithLetters = 'ab12cd34-5678-4abc-8def-abcdef123456';
    const uppercase = lowercaseWithLetters.toUpperCase();
    expect(() => buildClaudeLaunchConfig({ ...launch, resuming: true, sessionId: uppercase }, tokenFilePaths)).not.toThrow();
    const config = buildClaudeLaunchConfig({ ...launch, resuming: true, sessionId: uppercase }, tokenFilePaths);
    expect(config.args.slice(0, 2)).toEqual(['--resume', uppercase]);
  });

  it('does not guard a first-run (non-resuming) launch against a non-UUID session id — only resume is guarded', () => {
    expect(() => buildClaudeLaunchConfig({ ...launch, resuming: false, sessionId: 'not-a-uuid' }, tokenFilePaths)).not.toThrow();
    expect(() => buildClaudeLaunchConfig({ ...launch, sessionId: '' }, tokenFilePaths)).not.toThrow();
  });

  it('resuming a session passes --resume <id> and drops --session-id, --name and the prompt', () => {
    const config = buildClaudeLaunchConfig({ ...launch, resuming: true }, tokenFilePaths);
    expect(config.args.slice(0, 2)).toEqual(['--resume', launch.sessionId]);
    expect(config.args).not.toContain('--session-id');
    expect(config.args).not.toContain('--name');
    expect(config.args).not.toContain(launch.displayName);
  });

  it('resuming a session keeps --model when the session has one', () => {
    const config = buildClaudeLaunchConfig({ ...launch, resuming: true }, tokenFilePaths);
    const flagIndex = config.args.indexOf('--model');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(config.args[flagIndex + 1]).toBe(launch.model);
  });

  it('resuming still carries --settings and --mcp-config, so the same daemon hooks apply', () => {
    const config = buildClaudeLaunchConfig({ ...launch, resuming: true }, tokenFilePaths);
    expect(config.args.indexOf('--settings')).toBeGreaterThan(-1);
    expect(config.args.indexOf('--mcp-config')).toBeGreaterThan(-1);
  });

  it('keeps --permission-mode and --mcp-config as option flags before the seeded prompt separator, on a first run', () => {
    const config = buildClaudeLaunchConfig({ ...launch, seededPrompt: 'Say hello and stop.', permissionMode: 'acceptEdits' }, tokenFilePaths);
    const separatorIndex = config.args.indexOf('--');
    const permissionModeIndex = config.args.indexOf('--permission-mode');
    const mcpConfigIndex = config.args.indexOf('--mcp-config');
    expect(permissionModeIndex).toBeGreaterThan(-1);
    expect(permissionModeIndex).toBeLessThan(separatorIndex);
    expect(mcpConfigIndex).toBeLessThan(separatorIndex);
    expect(config.args.slice(-2)).toEqual(['--', 'Say hello and stop.']);
  });

  it('resuming with a seeded prompt drops the prompt, so it is never swallowed by --mcp-config nor rejected by --resume', () => {
    const config = buildClaudeLaunchConfig({ ...launch, resuming: true, seededPrompt: 'Say hello and stop.' }, tokenFilePaths);
    expect(config.args).not.toContain('Say hello and stop.');
  });

  it('resuming with a permission mode still passes --permission-mode after --resume <id>', () => {
    const config = buildClaudeLaunchConfig({ ...launch, resuming: true, permissionMode: 'acceptEdits' }, tokenFilePaths);
    const resumeIndex = config.args.indexOf('--resume');
    const flagIndex = config.args.indexOf('--permission-mode');
    expect(flagIndex).toBeGreaterThan(resumeIndex);
    expect(config.args[flagIndex + 1]).toBe('acceptEdits');
  });

  it('never repeats --settings or --mcp-config on a first run', () => {
    const config = buildClaudeLaunchConfig(launch, tokenFilePaths);
    expect(config.args.filter((arg) => arg === '--settings')).toHaveLength(1);
    expect(config.args.filter((arg) => arg === '--mcp-config')).toHaveLength(1);
  });

  it('never repeats --settings or --mcp-config while resuming', () => {
    const config = buildClaudeLaunchConfig({ ...launch, resuming: true }, tokenFilePaths);
    expect(config.args.filter((arg) => arg === '--settings')).toHaveLength(1);
    expect(config.args.filter((arg) => arg === '--mcp-config')).toHaveLength(1);
  });

  it('returns the same settings and mcp config whether the launch resumes or starts fresh, so daemon hooks and tokens do not drift on resume', () => {
    const firstRun = buildClaudeLaunchConfig(launch, tokenFilePaths);
    const resumed = buildClaudeLaunchConfig({ ...launch, resuming: true }, tokenFilePaths);
    expect(resumed.settings).toEqual(firstRun.settings);
    expect(resumed.mcpConfig).toEqual(firstRun.mcpConfig);
  });
});
