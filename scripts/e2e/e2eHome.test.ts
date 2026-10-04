import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { E2E_HOME_ENV, E2E_HOME_PREFIX, e2eConfigPath, e2eHomePath, ensureE2eHome, isRemovableE2eHome, readE2eAdminToken, removeE2eHome } from './e2eHome.js';

describe('removeE2eHome', () => {
  let tempRoot: string;

  beforeEach(() => { tempRoot = mkdtempSync(join(tmpdir(), 'e2e-home-test-')); });
  afterEach(() => { rmSync(tempRoot, { recursive: true, force: true }); });

  it('removes a directory created by mkdtemp with the e2e prefix inside the temp root', () => {
    const createdHome = mkdtempSync(join(tempRoot, E2E_HOME_PREFIX));
    writeFileSync(join(createdHome, 'admin.token'), 'secret');

    const removed = removeE2eHome(createdHome, tempRoot);

    expect(removed).toBe(true);
    expect(existsSync(createdHome)).toBe(false);
  });

  it.each([
    ['the filesystem root', () => '/'],
    ['the user home', () => homedir()],
    ['the system temp dir', () => '/tmp'],
    ['the legacy shared e2e home', () => '/tmp/of-e2e'],
    ['the temp root itself', () => tempRoot],
  ])('refuses %s', (_label, pathToRefuse) => {
    const removed = removeE2eHome(pathToRefuse(), tempRoot);

    expect(removed).toBe(false);
  });

  it('refuses a directory with the prefix but without the mkdtemp suffix', () => {
    const lookalikeHome = join(tempRoot, `${E2E_HOME_PREFIX}shared-between-runs`);
    mkdirSync(lookalikeHome);

    const removed = removeE2eHome(lookalikeHome, tempRoot);

    expect(removed).toBe(false);
    expect(existsSync(lookalikeHome)).toBe(true);
  });

  it('refuses a mkdtemp-named directory nested deeper than the temp root', () => {
    const nestedParent = join(tempRoot, 'nested');
    mkdirSync(nestedParent);
    const nestedHome = mkdtempSync(join(nestedParent, E2E_HOME_PREFIX));

    expect(isRemovableE2eHome(nestedHome, tempRoot)).toBe(false);
  });

  it('refuses a mkdtemp-named directory outside the temp root', () => {
    const otherRoot = mkdtempSync(join(tempRoot, 'other-'));
    const foreignHome = mkdtempSync(join(otherRoot, E2E_HOME_PREFIX));

    expect(isRemovableE2eHome(foreignHome, tempRoot)).toBe(false);
  });
});

describe('e2e home shared through the environment', () => {
  let previousHome: string | undefined;

  beforeEach(() => { previousHome = process.env[E2E_HOME_ENV]; });
  afterEach(() => {
    if (previousHome === undefined) delete process.env[E2E_HOME_ENV];
    else process.env[E2E_HOME_ENV] = previousHome;
  });

  it('reuses the home already announced in the environment instead of creating another one', () => {
    process.env[E2E_HOME_ENV] = '/announced/home';

    expect(ensureE2eHome()).toBe('/announced/home');
  });

  it('derives the config path and the admin token from the announced home', () => {
    const announcedHome = mkdtempSync(join(tmpdir(), E2E_HOME_PREFIX));
    try {
      process.env[E2E_HOME_ENV] = announcedHome;
      writeFileSync(join(announcedHome, 'admin.token'), 'token-value\n');

      expect(e2eConfigPath()).toBe(join(announcedHome, 'config.json'));
      expect(readE2eAdminToken()).toBe('token-value');
    } finally {
      removeE2eHome(announcedHome);
    }
  });

  it('fails loudly when no home is announced', () => {
    delete process.env[E2E_HOME_ENV];

    expect(() => e2eHomePath()).toThrow(E2E_HOME_ENV);
  });
});
