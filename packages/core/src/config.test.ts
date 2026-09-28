import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses OPENFLEET_HOME and persists a generated admin token', () => {
    const home = mkdtempSync(join(tmpdir(), 'of-home-'));
    const first = loadConfig({ OPENFLEET_HOME: home, OPENFLEET_PORT: '7999' });
    const second = loadConfig({ OPENFLEET_HOME: home });
    expect(first.port).toBe(7999);
    expect(first.adminToken).toHaveLength(43);
    expect(second.adminToken).toBe(first.adminToken);
    expect(readFileSync(join(home, 'admin.token'), 'utf8')).toBe(first.adminToken);
    expect(first.dbPath).toBe(join(home, 'openfleet.db'));
  });

  it('refuses to start on an empty admin token file instead of running with no secret', () => {
    const home = mkdtempSync(join(tmpdir(), 'of-home-'));
    writeFileSync(join(home, 'admin.token'), '');
    expect(() => loadConfig({ OPENFLEET_HOME: home })).toThrow(/admin token/i);
  });

  it('refuses to start on an admin token shorter than 32 characters', () => {
    const home = mkdtempSync(join(tmpdir(), 'of-home-'));
    writeFileSync(join(home, 'admin.token'), 'too-short');
    expect(() => loadConfig({ OPENFLEET_HOME: home })).toThrow(/admin token/i);
  });
});
