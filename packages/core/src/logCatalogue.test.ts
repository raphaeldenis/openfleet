import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CORE_SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CATALOGUE_FILE = join(CORE_SOURCE_DIRECTORY, '../../../apps/desktop/src-tauri/daemon_messages.txt');
const NOT_DAEMON_CODE = /\.test\.ts$|\.testkit\.ts$|\.probe\.test\.ts$/;
const NOT_DAEMON_DIRECTORIES = new Set(['__testing__']);

// A call `log('<level>', '<static literal>'` with the literal in single or double quotes, or in backticks without `${`.
const STATIC_LITERAL_LOG_CALL =
  /\blog\(\s*['"](?:debug|info|warn|error)['"]\s*,\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.|\$(?!\{))*)`)\s*[,)]/g;

function daemonSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return NOT_DAEMON_DIRECTORIES.has(entry.name) ? [] : daemonSourceFiles(path);
    return entry.name.endsWith('.ts') && !NOT_DAEMON_CODE.test(entry.name) ? [path] : [];
  });
}

const daemonSources = daemonSourceFiles(CORE_SOURCE_DIRECTORY).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

const staticLiteralsLogged = daemonSources.flatMap(({ path, text }) =>
  [...text.matchAll(STATIC_LITERAL_LOG_CALL)].map((match) => ({ path, literal: match[1] ?? match[2] ?? match[3] ?? '' })),
);

const catalogueLiterals = readFileSync(CATALOGUE_FILE, 'utf8')
  .split('\n')
  .filter((entry) => entry.includes(' '))
  .map((entry) => entry.slice(entry.indexOf(' ') + 1));

describe('the daemon message catalogue read by the desktop log', () => {
  it('finds the static log messages of the daemon', () => {
    expect(staticLiteralsLogged.length).toBeGreaterThan(10);
  });

  it('lists every static message the daemon logs', () => {
    const missing = staticLiteralsLogged.filter(({ literal }) => !catalogueLiterals.includes(literal));

    expect(missing, 'add each literal to apps/desktop/src-tauri/daemon_messages.txt as `<snake_case_id> <literal>`').toEqual([]);
  });

  it('lists no message the daemon stopped logging', () => {
    const stale = catalogueLiterals.filter((literal) => !daemonSources.some(({ text }) => text.includes(literal)));

    expect(stale).toEqual([]);
  });

  it('needs no escape in any listed literal', () => {
    expect(staticLiteralsLogged.filter(({ literal }) => literal.includes('\\'))).toEqual([]);
  });
});
