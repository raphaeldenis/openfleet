import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const E2E_HOME_ENV = 'OPENFLEET_E2E_HOME';
export const E2E_HOME_PREFIX = 'of-e2e-';

const MKDTEMP_SUFFIX_LENGTH = 6;
const createdHomeNamePattern = new RegExp(`^${E2E_HOME_PREFIX}[A-Za-z0-9]{${MKDTEMP_SUFFIX_LENGTH}}$`);

/** True only for a direct child of the temp root named like an mkdtemp result of the e2e prefix. */
export function isRemovableE2eHome(candidatePath: string, tempRoot: string = tmpdir()): boolean {
  const resolvedCandidate = resolve(candidatePath);
  const isDirectChildOfTempRoot = dirname(resolvedCandidate) === resolve(tempRoot);
  const hasCreatedHomeName = createdHomeNamePattern.test(basename(resolvedCandidate));
  return isDirectChildOfTempRoot && hasCreatedHomeName;
}

/** Removes the home when it passes the removable guard; returns whether it was removed. */
export function removeE2eHome(homePath: string, tempRoot: string = tmpdir()): boolean {
  if (!isRemovableE2eHome(homePath, tempRoot)) return false;
  rmSync(homePath, { recursive: true, force: true });
  return true;
}

/** Creates the per-run home once (the env var carries it to later config evaluations and to workers) and removes it when the creating process exits. */
export function ensureE2eHome(): string {
  const existingHome = process.env[E2E_HOME_ENV];
  if (existingHome) return existingHome;

  const createdHome = mkdtempSync(join(tmpdir(), E2E_HOME_PREFIX));
  process.env[E2E_HOME_ENV] = createdHome;
  process.once('exit', () => { removeE2eHome(createdHome); });
  return createdHome;
}

export function e2eHomePath(): string {
  const home = process.env[E2E_HOME_ENV];
  if (!home) throw new Error(`${E2E_HOME_ENV} is not set: the e2e home is created by playwright.config.ts`);
  return home;
}

export function e2eConfigPath(): string {
  return join(e2eHomePath(), 'config.json');
}

export function readE2eAdminToken(): string {
  return readFileSync(join(e2eHomePath(), 'admin.token'), 'utf8').trim();
}
