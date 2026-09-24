import { mkdtempSync, readFileSync } from 'node:fs';
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
});
