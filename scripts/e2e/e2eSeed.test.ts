import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureE2eSeed } from './e2eSeed.js';

const E2E_SEEDED_ENV = 'OPENFLEET_E2E_SEEDED';
const SEED_WRITER_TIMEOUT_IN_MS = 60_000;

describe('ensureE2eSeed', () => {
  let previousSeededFlag: string | undefined;
  let foreignHome: string;

  beforeEach(() => {
    previousSeededFlag = process.env[E2E_SEEDED_ENV];
    delete process.env[E2E_SEEDED_ENV];
    foreignHome = mkdtempSync(join(tmpdir(), 'not-an-e2e-home-'));
  });
  afterEach(() => {
    if (previousSeededFlag === undefined) delete process.env[E2E_SEEDED_ENV];
    else process.env[E2E_SEEDED_ENV] = previousSeededFlag;
    rmSync(foreignHome, { recursive: true, force: true });
  });

  it('refuses a home that is not a created e2e home, and writes nothing into it', () => {
    expect(() => ensureE2eSeed(foreignHome)).toThrow();

    expect(existsSync(join(foreignHome, 'openfleet.db'))).toBe(false);
    expect(process.env[E2E_SEEDED_ENV]).toBeUndefined();
  }, SEED_WRITER_TIMEOUT_IN_MS);
});
