import type { DiagnosticsDocument, DiagnosticsSession } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { allowlistedDaemonDocument, DAEMON_DOCUMENT_ALLOWLIST, OPENFLEET_HOME_ALIAS, UNRECOGNISED } from './daemon-document-allowlist';

const A_SESSION: Required<DiagnosticsSession> = {
  id: '123e4567-e89b-42d3-a456-426614174000',
  name: 'fix the login page',
  state: 'closed',
  harness: 'claude-cli',
  model: 'claude-opus-4-1',
  parentId: '223e4567-e89b-42d3-a456-426614174000',
  exitCode: 1,
  reason: 'harness_exit',
  closedAt: '2026-10-04T09:59:00.000Z',
  directory: '~/code/app',
};

/** A document that fills every field the daemon can send, optional ones included. */
const A_FULL_DOCUMENT: DiagnosticsDocument = {
  generatedAt: '2026-10-04T10:00:00.000Z',
  version: { openfleet: '0.9.1-beta.2', node: 'v24.1.0', platform: 'darwin' },
  config: { port: 7331, home: OPENFLEET_HOME_ALIAS, e2eEnabled: false },
  health: { status: 'degraded', issues: [{ code: 'db_stuck', since: '2026-10-04T09:00:00.000Z', message: 'The database did not answer.', id: '0a1b2c3d', count: 2 }] },
  migrations: [{ id: '054_project_shared_repo', appliedAt: '2026-10-01T08:00:00.000Z' }],
  db: { quickCheck: 'ok', sizeBytes: 4096 },
  sessions: [A_SESSION],
  log: [{ level: 'info', msg: 'hello' }],
};

const FRAGMENTS_OF_TOKEN_SHAPES = [['gh', 'p_'], ['s', 'k-ant-api03-'], ['AK', 'IA'], ['xo', 'xb-'], ['ey', 'J']];
const TOKEN_BODY = 'Q7f3Kx9LmZp2Rt8VwYb4Nc6Hd1Js5Ga0';

/** Token-shaped strings built at runtime, so no source line holds one. */
const hostileTokens = (): string[] => FRAGMENTS_OF_TOKEN_SHAPES.map((fragments) => `${fragments.join('')}${TOKEN_BODY}`);

const WINDOW_LENGTH = 12;
const windowsOf = (text: string): string[] => Array.from({ length: text.length - WINDOW_LENGTH + 1 }, (_, start) => text.slice(start, start + WINDOW_LENGTH));

/** Lists the leaf paths of a value, `[]` standing for any array item. */
function leafPathsOf(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => leafPathsOf(item, `${path}[]`));
  if (typeof value !== 'object' || value === null) return [path];
  return Object.entries(value).flatMap(([key, child]) => leafPathsOf(child, path === '' ? key : `${path}.${key}`));
}

/** Lists the paths the allowlist table names: a rule is a leaf, `eachItem` an array item. */
function allowlistPathsOf(entry: unknown, path = ''): string[] {
  if (typeof entry === 'function') return [path];
  const { eachItem } = entry as { eachItem?: unknown };
  if (eachItem !== undefined) return allowlistPathsOf(eachItem, `${path}[]`);
  return Object.entries(entry as object).flatMap(([key, child]) => allowlistPathsOf(child, path === '' ? key : `${path}.${key}`));
}

describe('the daemon document allowlist', () => {
  it('names every field of a full daemon document', () => {
    const documentPaths = new Set(leafPathsOf({ ...A_FULL_DOCUMENT, log: 'one rule for the whole ring buffer' }));
    const allowlistPaths = new Set(allowlistPathsOf(DAEMON_DOCUMENT_ALLOWLIST));

    const unlistedPaths = [...documentPaths].filter((path) => !allowlistPaths.has(path));

    expect(unlistedPaths).toEqual([]);
  });

  it('names no field the daemon document does not have', () => {
    const documentPaths = new Set(leafPathsOf({ ...A_FULL_DOCUMENT, log: 'one rule for the whole ring buffer' }));

    const deadPaths = allowlistPathsOf(DAEMON_DOCUMENT_ALLOWLIST).filter((path) => !documentPaths.has(path));

    expect(deadPaths).toEqual([]);
  });

  it('keeps the typed fields of a well-formed document and drops its free text and its log', () => {
    const allowlisted = allowlistedDaemonDocument(A_FULL_DOCUMENT);

    expect(allowlisted).toEqual({
      generatedAt: '2026-10-04T10:00:00.000Z',
      version: { openfleet: '0.9.1-beta.2', node: 'v24.1.0', platform: 'darwin' },
      config: { port: 7331, home: OPENFLEET_HOME_ALIAS, e2eEnabled: false },
      health: { status: 'degraded', issues: [{ code: 'db_stuck', since: '2026-10-04T09:00:00.000Z', id: '0a1b2c3d', count: 2 }] },
      migrations: [{ id: '054_project_shared_repo', appliedAt: '2026-10-01T08:00:00.000Z' }],
      db: { quickCheck: 'ok', sizeBytes: 4096 },
      sessions: [{ id: A_SESSION.id, state: 'closed', harness: 'claude-cli', model: 'opus', parentId: A_SESSION.parentId, exitCode: 1, reason: 'harness_exit', closedAt: '2026-10-04T09:59:00.000Z' }],
    });
  });

  it('leaves out an optional field the daemon did not send', () => {
    const { model: _model, parentId: _parentId, ...sessionWithoutOptionals } = A_SESSION;

    const allowlisted = allowlistedDaemonDocument({ ...A_FULL_DOCUMENT, sessions: [sessionWithoutOptionals] });

    expect(Object.keys((allowlisted['sessions'] as object[])[0]!)).not.toContain('model');
    expect(Object.keys((allowlisted['sessions'] as object[])[0]!)).not.toContain('parentId');
  });

  it('reduces a failed database check to "failed" and a model to its family', () => {
    const allowlisted = allowlistedDaemonDocument({ ...A_FULL_DOCUMENT, db: { quickCheck: 'row 3 missing from index idx_x', sizeBytes: 1 }, sessions: [{ ...A_SESSION, model: 'gpt-5-codex' }] });

    expect(allowlisted['db']).toEqual({ quickCheck: 'failed', sizeBytes: 1 });
    expect((allowlisted['sessions'] as { model: string }[])[0]!.model).toBe('other');
  });

  it('marks a value of the wrong shape unrecognised instead of copying it', () => {
    const allowlisted = allowlistedDaemonDocument({ ...A_FULL_DOCUMENT, generatedAt: 'yesterday', version: { openfleet: 'v1', node: 24, platform: 'beos' }, config: { port: '7331', home: '/Users/me/.openfleet', e2eEnabled: 'no' } });

    expect(allowlisted['generatedAt']).toBe(UNRECOGNISED);
    expect(allowlisted['version']).toEqual({ openfleet: UNRECOGNISED, node: UNRECOGNISED, platform: UNRECOGNISED });
    expect(allowlisted['config']).toEqual({ port: UNRECOGNISED, home: UNRECOGNISED, e2eEnabled: UNRECOGNISED });
  });

  describe('the daemon version', () => {
    const versionKeptAs = (openfleet: string): unknown => (allowlistedDaemonDocument({ ...A_FULL_DOCUMENT, version: { ...A_FULL_DOCUMENT.version, openfleet } })['version'] as { openfleet: string }).openfleet;

    it.each(['1.2.3', '1.2.3-rc.1', '1.2.3+412', '1.2.3+abc1234', '1.2.3+abc1234.7', '1.2.3-rc.1+412', '1.2.3+0123456789ab'])('keeps %s, as the desktop does', (version) => {
      expect(versionKeptAs(version)).toBe(version);
    });

    it.each(['dev', 'dev-0123abcd', 'dev-ffffffff'])('keeps the local dev build %s, as the desktop does', (version) => {
      expect(versionKeptAs(version)).toBe(version);
    });

    it.each(['dev-', 'dev-0123ABCD', 'dev-xyz', 'dev-0123abcde', 'dev-0123abc', 'dev+x', 'dev-0123abcd+412', 'Dev', 'develop', 'dev '])('reduces the malformed dev build %s to unrecognised', (version) => {
      expect(versionKeptAs(version)).toBe(UNRECOGNISED);
    });

    it.each(['1.2.3+', '1.2.3+build.7', '1.2.3+ABC1234', '1.2.3+abc-1234', '1.2.3+0123456789abc', '1.2.3+1.2.3', '1.2.3+1..2', '1.2.3+has_underscore', '1.2.3++1', '1.2.3+1+2', '+412'])('reduces %s to unrecognised', (version) => {
      expect(versionKeptAs(version)).toBe(UNRECOGNISED);
    });

    it('reduces a token-shaped build metadata to unrecognised', () => {
      const keptAs = hostileTokens().flatMap((token) => [`1.2.3+${token}`, `1.2.3+412.${token}`, `1.2.3-rc.1+${token}`]).map(versionKeptAs);

      expect(keptAs.every((kept) => kept === UNRECOGNISED)).toBe(true);
    });
  });

  it('copies no window of a token placed in any field, in an unknown field or in place of a list', () => {
    const tokens = hostileTokens();
    const [first, second, third, fourth, fifth] = tokens as [string, string, string, string, string];
    const hostile = {
      generatedAt: first,
      version: { openfleet: `1.2.3-${second}`, node: third, platform: fourth },
      config: { port: fifth, home: `/Users/${first}`, e2eEnabled: second, [third]: fourth },
      health: { status: first, issues: [{ code: second, since: third, message: `failed with ${fourth}`, id: fifth, count: first, [second]: third }] },
      migrations: [{ id: `001_${first}`, appliedAt: second }],
      db: { quickCheck: `corrupt: ${third}`, sizeBytes: fourth },
      sessions: [{ id: fifth, name: first, state: second, harness: third, model: fourth, parentId: fifth, exitCode: first, reason: second, closedAt: third, directory: `/Users/me/${fourth}` }],
      log: tokens,
      [fifth]: { nested: first },
      extra: [second, { deeper: third }],
    };

    const allowlistedText = JSON.stringify(allowlistedDaemonDocument(hostile));

    const leakedWindows = tokens.flatMap(windowsOf).filter((window) => allowlistedText.includes(window));
    expect(leakedWindows).toEqual([]);
  });

  it('reads a document that is not an object as an empty one', () => {
    expect(allowlistedDaemonDocument('not a document')).toEqual({});
    expect(allowlistedDaemonDocument({ ...A_FULL_DOCUMENT, sessions: 'none' })['sessions']).toEqual([]);
  });
});
