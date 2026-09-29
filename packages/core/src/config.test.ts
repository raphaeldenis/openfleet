import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const modeOf = (path: string): number => statSync(path).mode & 0o777;

let createdHomes: string[] = [];
const makeHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'of-home-'));
  createdHomes.push(home);
  return home;
};
afterEach(() => {
  for (const home of createdHomes) rmSync(home, { recursive: true, force: true });
  createdHomes = [];
});

describe('loadConfig', () => {
  it('uses OPENFLEET_HOME and persists a generated admin token', () => {
    const home = makeHome();
    const first = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '7999' });
    const second = loadConfig({ OPENFLEET_HOME: home });
    expect(first.port).toBe(7999);
    expect(first.adminToken).toHaveLength(43);
    expect(second.adminToken).toBe(first.adminToken);
    expect(readFileSync(join(home, 'admin.token'), 'utf8')).toBe(first.adminToken);
    expect(first.dbPath).toBe(join(home, 'openfleet.db'));
  });

  it('creates a fresh home directory at 0700 (AUD-05)', () => {
    const home = join(makeHome(), 'fresh');

    loadConfig({ OPENFLEET_HOME: home });

    expect(modeOf(home)).toBe(0o700);
  });

  it('tightens an existing, looser home directory to 0700 instead of leaving it as found (AUD-05)', () => {
    const home = makeHome();
    chmodSync(home, 0o755);

    loadConfig({ OPENFLEET_HOME: home });

    expect(modeOf(home)).toBe(0o700);
  });

  it('tightens an existing, looser worktrees directory to 0700 instead of leaving it as found (AUD-05)', () => {
    const home = makeHome();
    mkdirSync(join(home, 'worktrees'), { recursive: true, mode: 0o755 });

    loadConfig({ OPENFLEET_HOME: home });

    expect(modeOf(join(home, 'worktrees'))).toBe(0o700);
  });

  it('creates a fresh sessions directory at 0700 and exposes it as sessionsRoot (AUD-11)', () => {
    const home = makeHome();

    const config = loadConfig({ OPENFLEET_HOME: home });

    expect(config.sessionsRoot).toBe(join(home, 'sessions'));
    expect(modeOf(config.sessionsRoot)).toBe(0o700);
  });

  it('exposes the working state mirror directory as stateRoot, apart from the sessions directory', () => {
    const home = makeHome();

    const config = loadConfig({ OPENFLEET_HOME: home });

    expect(config.stateRoot).toBe(join(home, 'state'));
    expect(config.stateRoot).not.toBe(config.sessionsRoot);
  });

  it('tightens an existing, looser sessions directory to 0700 instead of leaving it as found (AUD-11)', () => {
    const home = makeHome();
    mkdirSync(join(home, 'sessions'), { recursive: true, mode: 0o755 });

    loadConfig({ OPENFLEET_HOME: home });

    expect(modeOf(join(home, 'sessions'))).toBe(0o700);
  });

  it('forces admin.token back to 0600 on every load, even one that finds it already looser (AUD-05)', () => {
    const home = makeHome();
    loadConfig({ OPENFLEET_HOME: home });
    chmodSync(join(home, 'admin.token'), 0o644);

    loadConfig({ OPENFLEET_HOME: home });

    expect(modeOf(join(home, 'admin.token'))).toBe(0o600);
  });

  it('refuses to start on an empty admin token file instead of running with no secret', () => {
    const home = makeHome();
    writeFileSync(join(home, 'admin.token'), '');
    expect(() => loadConfig({ OPENFLEET_HOME: home })).toThrow(/admin token/i);
  });

  it('refuses to start on an admin token shorter than 32 characters', () => {
    const home = makeHome();
    writeFileSync(join(home, 'admin.token'), 'too-short');
    expect(() => loadConfig({ OPENFLEET_HOME: home })).toThrow(/admin token/i);
  });
});
