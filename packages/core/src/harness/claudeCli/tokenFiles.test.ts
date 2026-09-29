import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deleteTokenFiles, pathsIn, tokenFilesDirFor, writeTokenFiles } from './tokenFiles.js';

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
  it('creates the per-launch directory at 0700 and both files at 0600', () => {
    const sessionsRoot = tempSessionsRoot();
    const dir = tokenFilesDirFor(sessionsRoot, sessionId);

    writeTokenFiles(dir, { hooks: 'x' }, { mcpServers: 'y' });

    const { settingsPath, mcpConfigPath } = pathsIn(dir);
    expect(modeOf(dir)).toBe(0o700);
    expect(modeOf(settingsPath)).toBe(0o600);
    expect(modeOf(mcpConfigPath)).toBe(0o600);
  });

  it('writes exactly the given settings and mcp config as JSON', () => {
    const sessionsRoot = tempSessionsRoot();
    const dir = tokenFilesDirFor(sessionsRoot, sessionId);
    const settings = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'x' }] }] } };
    const mcpConfig = { mcpServers: { openfleet: { headers: { Authorization: 'Bearer tok-mcp' } } } };

    writeTokenFiles(dir, settings, mcpConfig);

    const { settingsPath, mcpConfigPath } = pathsIn(dir);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual(settings);
    expect(JSON.parse(readFileSync(mcpConfigPath, 'utf8'))).toEqual(mcpConfig);
  });

  it('refuses to write over a file that already exists at the same path (O_EXCL), instead of silently overwriting it', () => {
    const sessionsRoot = tempSessionsRoot();
    const dir = tokenFilesDirFor(sessionsRoot, sessionId);
    writeTokenFiles(dir, { hooks: 'first' }, { mcpServers: 'first' });

    expect(() => writeTokenFiles(dir, { hooks: 'second' }, { mcpServers: 'second' })).toThrow(/EEXIST/);
  });
});

describe('deleteTokenFiles', () => {
  it('removes the whole per-launch directory, files included', () => {
    const sessionsRoot = tempSessionsRoot();
    const dir = tokenFilesDirFor(sessionsRoot, sessionId);
    writeTokenFiles(dir, { hooks: 'x' }, { mcpServers: 'y' });

    deleteTokenFiles(dir);

    expect(existsSync(dir)).toBe(false);
  });

  it('does not throw when the directory is already gone', () => {
    const sessionsRoot = tempSessionsRoot();
    const dir = tokenFilesDirFor(sessionsRoot, sessionId);

    expect(() => deleteTokenFiles(dir)).not.toThrow();
  });
});
