import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { refuseBootOnFailure } from './bootFailure.js';
import { ConfigFileError } from './configFileError.js';
import { applyMigrations, MigrationFailedError } from './db/migrate.js';
import { PortInUseError } from './errors/portInUseError.js';

const CORE_SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CATALOGUE_FILE = join(CORE_SOURCE_DIRECTORY, '../../../apps/desktop/src-tauri/boot_refusals.txt');
const REFUSAL_SOURCE_FILES = ['bootFailure.ts', 'db/migrate.ts'];
const UNLISTED = 'unlisted';

const catalogue = readFileSync(CATALOGUE_FILE, 'utf8')
  .split('\n')
  .filter((entry) => entry.includes(' '))
  .map((entry) => ({ id: entry.slice(0, entry.indexOf(' ')), literal: entry.slice(entry.indexOf(' ') + 1) }));

const refusalSources = REFUSAL_SOURCE_FILES.map((path) => readFileSync(join(CORE_SOURCE_DIRECTORY, path), 'utf8'));

/** The rule the desktop applies to a refusal line: the first entry whose literal follows ` (` names the reason. */
const reasonIdOf = (refusalLine: string) => catalogue.find(({ literal }) => refusalLine.includes(` (${literal}`))?.id ?? UNLISTED;

async function refusalLineOf(error: unknown): Promise<string> {
  const written: string[] = [];
  const exit = (): never => { throw new Error('process exited'); };
  await refuseBootOnFailure(async () => { throw error; }, { configPath: '/home/of/config.json', writeStderr: (text) => written.push(text), exit }).catch(() => undefined);
  return written.join('');
}

function schemaNewerThanCodeError(): unknown {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  db.prepare("INSERT INTO schema_migrations (version, applied_at, checksum) VALUES ('999_from_a_newer_app', 't', 'x')").run();
  try {
    applyMigrations(db);
  } catch (error) {
    return error;
  }
  throw new Error('a database newer than the code was not refused');
}

/** The static text of every hint `recoveryHintOf` returns: a quoted literal, or the head of a template before its first `${`. */
function staticHintsOfBootFailure(): string[] {
  const source = refusalSources[0]!;
  const body = source.slice(source.indexOf('function recoveryHintOf'), source.indexOf('\n}\n', source.indexOf('function recoveryHintOf')));
  const quoted = [...body.matchAll(/return '([^']+)'/g)].map((match) => match[1]!);
  const templateHeads = [...body.matchAll(/`([^`$]+)\$\{/g)].map((match) => match[1]!.trim());
  return [...quoted, ...templateHeads];
}

describe('the boot refusal catalogue read by the desktop status line', () => {
  it.each([
    ['port_in_use', () => new PortInUseError(7331)],
    ['port_invalid', () => Object.assign(new RangeError('options.port should be >= 0 and < 65536.'), { code: 'ERR_SOCKET_BAD_PORT' })],
    ['path_not_permitted', () => Object.assign(new Error("EACCES: denied, rmdir '/home/of/sessions/x'"), { code: 'EACCES', path: '/home/of/sessions/x' })],
    ['migration_failed', () => new MigrationFailedError(new Error('no such table: sessions'), '/home/of/backups/openfleet-015-1.db')],
    ['schema_newer_than_code', schemaNewerThanCodeError],
    ['config_file_invalid', () => new ConfigFileError(new Error('workingState.maxAgeMinutes: too small'))],
    [UNLISTED, () => new Error('admin token is too short')],
  ])('names the reason %s from the line the daemon writes', async (expectedId, buildError) => {
    const refusalLine = await refusalLineOf(buildError());

    expect(reasonIdOf(refusalLine)).toBe(expectedId);
  });

  it('lists every hint the daemon appends to a refusal', () => {
    const literals = catalogue.map(({ literal }) => literal);

    const missing = staticHintsOfBootFailure().filter((hint) => !literals.includes(hint));

    expect(staticHintsOfBootFailure().length).toBeGreaterThan(2);
    expect(missing, 'add each hint to apps/desktop/src-tauri/boot_refusals.txt as `<snake_case_id> <literal>`').toEqual([]);
  });

  it('lists no literal the daemon stopped writing', () => {
    const stale = catalogue.filter(({ literal }) => !refusalSources.some((source) => source.includes(literal)));

    expect(stale).toEqual([]);
  });

  it('gives each reason a unique snake_case id', () => {
    const ids = catalogue.map(({ id }) => id);

    expect(ids.every((id) => /^[a-z][a-z0-9_]*$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(UNLISTED);
  });
});
