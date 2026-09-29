import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deleteTokenFiles, pathsIn, sweepStaleSessions, tokenFilesDirFor, writeTokenFiles } from './tokenFiles.js';

const modeOf = (path: string): number => statSync(path).mode & 0o777;
const sessionId = '11111111-1111-4111-8111-111111111111';

function tempSessionsRoot(): string {
  return mkdtempSync(join(tmpdir(), 'of-sessions-'));
}

describe('tokenFilesDirFor', () => {
  it('never returns the same directory twice for the same session, even across the same sessions root', () => {
    const sessionsRoot = tempSessionsRoot();
    const first = tokenFilesDirFor(sessionsRoot, sessionId);
    const second = tokenFilesDirFor(sessionsRoot, sessionId);
    expect(first).not.toBe(second);
  });

  it('nests the per-launch directory under the session id, under the sessions root', () => {
    const sessionsRoot = tempSessionsRoot();
    const dir = tokenFilesDirFor(sessionsRoot, sessionId);
    expect(dir.startsWith(join(sessionsRoot, sessionId))).toBe(true);
  });
});

describe('writeTokenFiles', () => {
  it('creates the per-launch directory at 0700 and all three files at 0600', () => {
    const sessionsRoot = tempSessionsRoot();
    const dir = tokenFilesDirFor(sessionsRoot, sessionId);

    writeTokenFiles(dir, { hooks: 'x' }, { mcpServers: 'y' }, 'url = "http://127.0.0.1:7331/hooks/tok"');

    const { settingsPath, mcpConfigPath, hookCurlConfigPath } = pathsIn(dir);
    expect(modeOf(dir)).toBe(0o700);
    expect(modeOf(settingsPath)).toBe(0o600);
    expect(modeOf(mcpConfigPath)).toBe(0o600);
    expect(modeOf(hookCurlConfigPath)).toBe(0o600);
  });

  it('writes exactly the given settings and mcp config as JSON, and the hook curl config as plain text', () => {
    const sessionsRoot = tempSessionsRoot();
    const dir = tokenFilesDirFor(sessionsRoot, sessionId);
    const settings = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'x' }] }] } };
    const mcpConfig = { mcpServers: { openfleet: { headers: { Authorization: 'Bearer tok-mcp' } } } };
    const hookCurlConfig = 'url = "http://127.0.0.1:7331/hooks/tok-hook"';

    writeTokenFiles(dir, settings, mcpConfig, hookCurlConfig);

    const { settingsPath, mcpConfigPath, hookCurlConfigPath } = pathsIn(dir);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual(settings);
    expect(JSON.parse(readFileSync(mcpConfigPath, 'utf8'))).toEqual(mcpConfig);
    expect(readFileSync(hookCurlConfigPath, 'utf8')).toBe(hookCurlConfig);
  });

  it('tightens a pre-existing, looser launch directory to 0700 instead of leaving it as found', () => {
    const sessionsRoot = tempSessionsRoot();
    const dir = tokenFilesDirFor(sessionsRoot, sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o755 });

    writeTokenFiles(dir, { hooks: 'x' }, { mcpServers: 'y' }, 'z');

    expect(modeOf(dir)).toBe(0o700);
  });

  it('refuses to write over a file that already exists at the same path (O_EXCL), instead of silently overwriting it', () => {
    const sessionsRoot = tempSessionsRoot();
    const dir = tokenFilesDirFor(sessionsRoot, sessionId);
    writeTokenFiles(dir, { hooks: 'first' }, { mcpServers: 'first' }, 'first');

    expect(() => writeTokenFiles(dir, { hooks: 'second' }, { mcpServers: 'second' }, 'second')).toThrow(/EEXIST/);
  });

  it('removes the launch directory, including a file that did write successfully, when a later file in the same call fails to write', () => {
    const sessionsRoot = tempSessionsRoot();
    const dir = tokenFilesDirFor(sessionsRoot, sessionId);
    const { mcpConfigPath } = pathsIn(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(mcpConfigPath, 'stale', { mode: 0o600 }); // pre-existing file forces the 2nd write to EEXIST

    expect(() => writeTokenFiles(dir, { hooks: 'x' }, { mcpServers: 'y' }, 'z')).toThrow(/EEXIST/);

    expect(existsSync(dir)).toBe(false); // the settings file that DID write must not survive as an orphan
  });
});

describe('deleteTokenFiles', () => {
  it('removes the whole per-launch directory, files included', () => {
    const sessionsRoot = tempSessionsRoot();
    const dir = tokenFilesDirFor(sessionsRoot, sessionId);
    writeTokenFiles(dir, { hooks: 'x' }, { mcpServers: 'y' }, 'z');

    deleteTokenFiles(dir);

    expect(existsSync(dir)).toBe(false);
  });

  it('does not throw when the directory is already gone', () => {
    const sessionsRoot = tempSessionsRoot();
    const dir = tokenFilesDirFor(sessionsRoot, sessionId);

    expect(() => deleteTokenFiles(dir)).not.toThrow();
  });
});

describe('sweepStaleSessions', () => {
  it('deletes every launch dir left under the sessions root from a previous boot', () => {
    const sessionsRoot = tempSessionsRoot();
    const dir = tokenFilesDirFor(sessionsRoot, sessionId);
    writeTokenFiles(dir, { hooks: 'x' }, { mcpServers: 'y' }, 'z');

    sweepStaleSessions(sessionsRoot);

    expect(readdirSync(sessionsRoot)).toEqual([]);
  });

  it('does not throw when the sessions root does not exist yet', () => {
    const sessionsRoot = join(tempSessionsRoot(), 'never-created');

    expect(() => sweepStaleSessions(sessionsRoot)).not.toThrow();
  });

  it('leaves the sessions root itself usable for a fresh launch right after the sweep', () => {
    const sessionsRoot = tempSessionsRoot();
    const staleDir = tokenFilesDirFor(sessionsRoot, sessionId);
    writeTokenFiles(staleDir, { hooks: 'stale' }, { mcpServers: 'stale' }, 'stale');

    sweepStaleSessions(sessionsRoot);
    const freshDir = tokenFilesDirFor(sessionsRoot, sessionId);
    writeTokenFiles(freshDir, { hooks: 'fresh' }, { mcpServers: 'fresh' }, 'fresh');

    const { settingsPath } = pathsIn(freshDir);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ hooks: 'fresh' });
  });
});
