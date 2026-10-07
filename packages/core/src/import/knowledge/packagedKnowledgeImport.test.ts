import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../db/database.js';
import { applyMigrations } from '../../db/migrate.js';
import { createTempDirTracker } from '../../tempDirTracker.js';

const timestamp = '2026-10-07T00:00:00.000Z';
const sourceRow = (id: string) => ({ id, repo: 'source', area: 'architecture', fact: `Searchable knowledge ${id}`, source_task: null as string | null, source_kind: null as string | null, verified_by: null as string | null, created_at: timestamp, retired_at: null as string | null, retired_why: null as string | null });

describe('packaged knowledge import', () => {
  const directories = createTempDirTracker();
  let bundlePath: string;
  let workDir: string;
  let home: string;
  let file: string;
  let mappingFile: string;
  let rows: ReturnType<typeof sourceRow>[];
  let manifest: { snapshot_id: string; frozen_at: string | null; freeze_verified: boolean; exported_at?: string };
  let mapping: { version: number; repos: { source_repo: string; project_id: string; repo_key: string; canonical_root: string }[] };

  beforeAll(async () => {
    const bundleDir = directories.make('knowledge-bundle-');
    bundlePath = join(bundleDir, 'daemon.mjs');
    symlinkSync(fileURLToPath(new URL('../../../node_modules', import.meta.url)), join(bundleDir, 'node_modules'), 'dir');
    cpSync(fileURLToPath(new URL('../../db/migrations', import.meta.url)), join(bundleDir, 'migrations'), { recursive: true });
    await build({ entryPoints: [fileURLToPath(new URL('../../main.ts', import.meta.url))], outfile: bundlePath, bundle: true, platform: 'node', format: 'esm', external: ['node-pty'], banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
  });

  beforeEach(() => {
    workDir = realpathSync.native(directories.make('knowledge-fixture-'));
    home = join(workDir, 'home');
    file = join(workDir, 'snapshot.json');
    mappingFile = join(workDir, 'mapping.json');
    const repo = join(workDir, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    mkdirSync(home);
    const db = openDatabase(join(home, 'openfleet.db'));
    db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('project', 'Fixture', timestamp);
    db.close();
    rows = [sourceRow('1'), { ...sourceRow('2'), retired_at: timestamp, retired_why: 'obsolete' }];
    manifest = { snapshot_id: 'rehearsal', frozen_at: null, freeze_verified: false };
    mapping = { version: 1, repos: [{ source_repo: 'source', project_id: 'project', repo_key: 'repo', canonical_root: repo }] };
  });

  afterAll(() => directories.removeAll());

  const writeInputs = () => {
    const retired = rows.filter((row) => row.retired_at !== null).length;
    writeFileSync(file, JSON.stringify({ version: 1, source: 'scape_team.memory.knowledge', exported_at: timestamp, ...manifest, repos: [{ repo: 'source', count: rows.length, active_count: rows.length - retired, retired_count: retired }], rows }), { mode: 0o600 });
    writeFileSync(mappingFile, JSON.stringify(mapping), { mode: 0o600 });
  };
  const run = (flags: string[] = [], input: { preloadPath?: string } = {}) => {
    const preloadArgs = input.preloadPath === undefined ? [] : ['--import', input.preloadPath];
    const result = spawnSync(process.execPath, [...preloadArgs, bundlePath, 'import', 'knowledge', '--file', file, '--mapping', mappingFile, '--home', home, ...flags], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, OPENFLEET_HOME: join(workDir, 'unexpected'), OPENFLEET_PORT: 'invalid' } });
    return { ...result, report: () => JSON.parse(result.stdout) as Record<string, unknown> };
  };
  const inspect = <T>(read: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(join(home, 'openfleet.db'));
    try { return read(db); } finally { db.close(); }
  };
  const state = () => inspect((db) => ['knowledge_repositories', 'knowledge', 'knowledge_import_entries', 'knowledge_import_runs', 'knowledge_import_mappings'].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));

  it('prints knowledge help before opening databases, listening or writing logs', () => {
    const preloadPath = join(workDir, 'daemon-side-effect-guard.mjs');
    writeFileSync(preloadPath, `import net from 'node:net';
import sqlite from 'node:sqlite';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const rejectSideEffect = () => { throw new Error('DAEMON_SIDE_EFFECT'); };
net.Server.prototype.listen = rejectSideEffect;
sqlite.DatabaseSync = rejectSideEffect;
fs.mkdirSync = rejectSideEffect;
fs.writeFileSync = rejectSideEffect;
fs.appendFileSync = rejectSideEffect;
syncBuiltinESMExports();`);

    const result = run(['--help'], { preloadPath });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('--mem02-acceptance');
    expect(result.stderr).toBe('');
    expect(existsSync(join(workDir, 'unexpected'))).toBe(false);
  });

  it('R1 imports all retirement states with deterministic ids and exact replay writes nothing', () => {
    writeInputs();
    const first = run();
    expect(first.status, first.stderr).toBe(0);
    expect(first.report()).toMatchObject({ source_rows: 2, source_active: 1, source_retired: 1, inserted: 2, updated: 0, unchanged: 0 });
    const imported = state();
    const second = run();
    expect(second.status, second.stderr).toBe(0);
    expect(second.report()).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 });
    expect(state()).toEqual(imported);
    const ids = inspect((db) => db.prepare('SELECT id FROM knowledge ORDER BY id').all());
    expect(ids).toEqual(['1', '2'].map((id) => ({ id: `pg:cHJvamVjdA:cmVwbw:${Buffer.from(id).toString('base64url')}` })));
  });

  it('R1 reconciles changed source only while the imported target remains intact', () => {
    writeInputs();
    expect(run().status).toBe(0);
    rows[0]!.fact = 'Changed source';
    manifest.snapshot_id = 'second';
    writeInputs();
    expect(run().report()).toMatchObject({ updated: 1, unchanged: 1 });
    inspect((db) => db.prepare('UPDATE knowledge SET fact = ? WHERE retired_at IS NULL').run('Local curation'));
    rows[0]!.fact = 'Another source change';
    writeInputs();
    const before = state();
    expect(run().report()).toMatchObject({ conflicts: 1 });
    expect(state()).toEqual(before);
  });

  it.each(['missing_source', 'missing_target', 'remap', 'project_remap'] as const)('R1 refuses %s and aborts every change', (conflict) => {
    writeInputs();
    expect(run().status).toBe(0);
    if (conflict === 'missing_source') rows.pop();
    if (conflict === 'missing_target') inspect((db) => { db.exec('PRAGMA foreign_keys = OFF'); db.exec('DELETE FROM knowledge WHERE retired_at IS NOT NULL'); });
    if (conflict === 'remap') mapping.repos[0]!.repo_key = 'other';
    if (conflict === 'project_remap') {
      inspect((db) => db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('other', 'Other', timestamp));
      mapping.repos[0]!.project_id = 'other';
      mapping.repos[0]!.repo_key = 'other';
    }
    rows[0]!.fact = 'Must never commit';
    writeInputs();
    const before = state();
    const result = run();
    expect(result.status).toBe(1);
    expect(result.report()).toMatchObject({ conflicts: expect.any(Number) });
    expect(state()).toEqual(before);
  });

  it('R1 rolls back the entire file when row 502 fails in SQLite', () => {
    rows = Array.from({ length: 502 }, (_, index) => sourceRow(String(index + 1)));
    writeInputs();
    inspect((db) => db.exec("CREATE TRIGGER fixture_failure BEFORE INSERT ON knowledge WHEN new.fact = 'Searchable knowledge 502' BEGIN SELECT RAISE(ABORT, 'sensitive fixture failure'); END"));
    const before = state();
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('sensitive fixture');
    expect(state()).toEqual(before);
  });

  it('reports only counts when SQLite rollback itself fails', () => {
    writeInputs();
    inspect((db) => db.exec("CREATE TRIGGER fixture_failure BEFORE INSERT ON knowledge BEGIN SELECT RAISE(ABORT, 'sensitive fixture failure'); END"));
    const preloadPath = join(workDir, 'rollback-failure.mjs');
    writeFileSync(preloadPath, `import { DatabaseSync } from 'node:sqlite';
const execute = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  if (sql === 'ROLLBACK') throw new Error('RollbackFixtureCredential');
  return execute.call(this, sql);
};`);
    const before = state();

    const result = run([], { preloadPath });

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain('RollbackFixtureCredential');
    expect(result.stdout + result.stderr).not.toContain(workDir);
    expect(result.report()).toMatchObject({ reason: 'IMPORT_WRITE_FAILED', committed: false });
    expect(state()).toEqual(before);
  });

  it('reports a committed import when target close fails without exposing the exception', () => {
    writeInputs();
    const preloadPath = join(workDir, 'close-failure.mjs');
    writeFileSync(preloadPath, `import { DatabaseSync } from 'node:sqlite';
const close = DatabaseSync.prototype.close;
DatabaseSync.prototype.close = function() {
  const imported = this.prepare('SELECT count(*) AS count FROM knowledge_import_runs').get().count > 0;
  close.call(this);
  if (imported) throw new Error('CloseFixtureCredential');
};`);

    const result = run([], { preloadPath });

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain('CloseFixtureCredential');
    expect(result.stdout + result.stderr).not.toContain(workDir);
    expect(result.report()).toMatchObject({ reason: 'IMPORT_WRITE_FAILED', committed: true, inserted: 2 });
    expect(inspect((db) => db.prepare('SELECT count(*) AS count FROM knowledge').get())).toEqual({ count: 2 });
  });

  it('R7 a failed final import leaves no seal or native authority', () => {
    rows = Array.from({ length: 502 }, (_, index) => sourceRow(String(index + 1)));
    manifest = { snapshot_id: 'final', frozen_at: timestamp, freeze_verified: true };
    writeInputs();
    inspect((db) => db.exec("CREATE TRIGGER fixture_failure BEFORE INSERT ON knowledge WHEN new.fact = 'Searchable knowledge 502' BEGIN SELECT RAISE(ABORT, 'sensitive fixture failure'); END"));
    const before = state();

    const result = run(['--final', '--mem02-acceptance', 'MEM-02-reviewed']);

    expect(result.status).toBe(1);
    expect(result.report()).toMatchObject({ source_rows: 502, inserted: 0, committed: false });
    expect(state()).toEqual(before);
    expect(run(['--activate', '--mem02-acceptance', 'MEM-02-reviewed']).status).toBe(1);
    expect(state()).toEqual(before);
  });

  it('refuses an unknown project before creating a real target home', () => {
    writeInputs();
    home = join(workDir, 'absent');

    const result = run();

    expect(result.status).toBe(1);
    expect(result.report()).toMatchObject({ reason: 'UNKNOWN_PROJECT' });
    expect(existsSync(home)).toBe(false);
  });

  it('R5 masks every free-text field before storage and FTS indexing without logging contents', () => {
    const secrets = ['sk-abcdefghijklmnopqrstuvwxyz0123456789', 'Bearer abcdefghijklmnopqrstuvwxyz', 'Cookie: session=supersecretcredential', 'https://user:supersecretcredential@example.com', '{"token":"supersecretcredential"}'];
    rows = secrets.map((secret, index) => ({ ...sourceRow(String(index)), area: secret, fact: `searchterm ${secret}`, source_task: secret, source_kind: secret, verified_by: secret, retired_at: timestamp, retired_why: secret }));
    writeInputs();
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    const stored = JSON.stringify(state());
    const indexed = inspect((db) => JSON.stringify(db.prepare("SELECT area, fact FROM knowledge_fts WHERE knowledge_fts MATCH 'searchterm'").all()));
    for (const secret of ['abcdefghijklmnopqrstuvwxyz', 'supersecretcredential']) {
      expect(stored).not.toContain(secret);
      expect(indexed).not.toContain(secret);
      expect(inspect((db) => db.prepare('SELECT count(*) AS count FROM knowledge_fts WHERE knowledge_fts MATCH ?').get(secret))).toEqual({ count: 0 });
      expect(result.stdout + result.stderr).not.toContain(secret);
    }
    expect(result.stdout + result.stderr).not.toContain(mapping.repos[0]!.canonical_root);
    expect(readFileSync(file, 'utf8')).toContain('supersecretcredential');
  });

  it('dry-run creates nothing in a missing home and leaves an existing target byte-identical', () => {
    writeInputs();
    const sourceBytes = readFileSync(file);
    const before = state();
    const databaseBytes = readFileSync(join(home, 'openfleet.db'));
    expect(run(['--dry-run']).status).toBe(0);
    expect(state()).toEqual(before);
    expect(readFileSync(join(home, 'openfleet.db'))).toEqual(databaseBytes);
    home = join(workDir, 'absent');
    expect(run(['--dry-run']).status).toBe(1);
    expect(existsSync(home)).toBe(false);
    expect(readFileSync(file)).toEqual(sourceBytes);
  });

  it.each(['input', 'mapping', 'report'] as const)('refuses a symlink for %s', (target) => {
    writeInputs();
    const link = join(workDir, 'link');
    symlinkSync(target === 'mapping' ? mappingFile : file, link);
    if (target === 'input') file = link;
    if (target === 'mapping') mappingFile = link;
    const before = state();
    const result = run(target === 'report' ? ['--report-file', link] : []);
    expect(result.status).toBe(1);
    expect(state()).toEqual(before);
  });

  it('refuses a symlink in an input ancestor', () => {
    writeInputs();
    const alias = join(workDir, 'alias');
    symlinkSync(workDir, alias, 'dir');
    file = join(alias, 'snapshot.json');
    const before = state();

    expect(run().report()).toMatchObject({ reason: 'SYMLINK_REFUSED', committed: false });
    expect(state()).toEqual(before);
  });

  it.each(['same_path', 'hard_link'] as const)('refuses a report that aliases the source through %s', (alias) => {
    writeInputs();
    const sourceBytes = readFileSync(file);
    const reportFile = alias === 'same_path' ? file : join(workDir, 'report.json');
    if (alias === 'hard_link') linkSync(file, reportFile);
    const before = state();

    expect(run(['--report-file', reportFile]).report()).toMatchObject({ reason: 'REPORT_WRITE_FAILED', committed: false });
    expect(readFileSync(file)).toEqual(sourceBytes);
    expect(state()).toEqual(before);
  });

  it.each(['openfleet.db', 'openfleet.db-wal', 'openfleet.db-shm', 'config.json'])('refuses a report using the target state file %s', (name) => {
    writeInputs();
    const before = state();

    expect(run(['--report-file', join(home, name)]).report()).toMatchObject({ reason: 'REPORT_WRITE_FAILED', committed: false });
    expect(state()).toEqual(before);
  });

  it.each(['fact', 'area', 'id', 'date', 'unicode', 'count', 'rows', 'file'] as const)('validates the %s bound before any write', (bound) => {
    if (bound === 'fact') rows[1]!.fact = 'é'.repeat(4097);
    if (bound === 'area') rows[1]!.area = 'é'.repeat(513);
    if (bound === 'id') rows[1]!.id = 'é'.repeat(257);
    if (bound === 'date') rows[1]!.created_at = '2026-02-30T00:00:00Z';
    if (bound === 'unicode') rows[1]!.fact = '\ud800';
    if (bound === 'rows') rows = Array.from({ length: 50_001 }, (_, index) => sourceRow(String(index)));
    writeInputs();
    if (bound === 'count') { const input = JSON.parse(readFileSync(file, 'utf8')); input.repos[0].count += 1; writeFileSync(file, JSON.stringify(input)); }
    if (bound === 'file') writeFileSync(file, ' '.repeat(32 * 1024 * 1024) + readFileSync(file, 'utf8'));
    const before = state();
    const result = run();
    expect(result.status).toBe(1);
    expect(result.report()).toMatchObject({ reason: bound === 'file' ? 'INPUT_TOO_LARGE' : 'INVALID_EXPORT' });
    expect(state()).toEqual(before);
  });

  it('refuses a target held by the daemon', () => {
    writeInputs();
    const daemon = new DatabaseSync(join(home, 'openfleet.db'));
    daemon.prepare('SELECT * FROM projects').all();
    try {
      const result = run();
      expect(result.status).toBe(1);
      expect(result.report()).toMatchObject({ reason: 'DAEMON_RUNNING' });
    } finally { daemon.close(); }
  });

  it('R5 reports only counts when unknown, short and numeric credentials remain readable', () => {
    rows[0]!.fact = 'token: abc token: 123456789 mystery credential UnrecognizedOpaqueCredential';
    writeInputs();
    const result = run();
    expect(result.status).toBe(0);
    expect(inspect((db) => db.prepare('SELECT fact FROM knowledge WHERE retired_at IS NULL').get())).toEqual({ fact: rows[0]!.fact });
    for (const residue of ['123456789', 'UnrecognizedOpaqueCredential']) expect(result.stdout + result.stderr).not.toContain(residue);
  });

  it('imports and seals a declared empty repository without inventing facts', () => {
    rows = [];
    manifest = { snapshot_id: 'empty-final', frozen_at: timestamp, freeze_verified: true };
    writeInputs();
    expect(run(['--final', '--mem02-acceptance', 'MEM-02-reviewed']).status).toBe(0);
    const provenance = inspect((db) => db.prepare('SELECT id, snapshot_id, snapshot_digest, mem02_acceptance FROM knowledge_import_runs').get());
    expect(provenance).toMatchObject({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), snapshot_id: manifest.snapshot_id, snapshot_digest: expect.stringMatching(/^[0-9a-f]{64}$/), mem02_acceptance: 'MEM-02-reviewed' });
    expect(run(['--activate', '--mem02-acceptance', 'MEM-02-reviewed']).status).toBe(0);
    expect(inspect((db) => db.prepare('SELECT authority FROM knowledge_repositories').get())).toEqual({ authority: 'native' });
    expect(state()[1]).toEqual([]);
  });

  it('R7 sealed replay refuses changed snapshot metadata, mappings and native edits', () => {
    manifest = { snapshot_id: 'final', frozen_at: timestamp, freeze_verified: true };
    writeInputs();
    expect(run(['--final', '--mem02-acceptance', 'MEM-02-reviewed']).status).toBe(0);
    expect(run(['--activate', '--mem02-acceptance', 'MEM-02-reviewed']).status).toBe(0);
    const sealed = state();
    manifest.exported_at = '2026-10-07T01:00:00.000Z';
    writeInputs();
    expect(run().status).toBe(1);
    expect(state()).toEqual(sealed);
    delete manifest.exported_at;
    manifest.snapshot_id = 'another-snapshot';
    writeInputs();
    expect(run().status).toBe(1);
    expect(state()).toEqual(sealed);
    manifest.snapshot_id = 'final';
    mapping.repos[0]!.repo_key = 'other';
    writeInputs();
    expect(run().status).toBe(1);
    expect(state()).toEqual(sealed);
    mapping.repos[0]!.repo_key = 'repo';
    writeInputs();
    inspect((db) => db.prepare('UPDATE knowledge SET fact = ? WHERE retired_at IS NULL').run('Native approved curation'));
    const curated = state();
    expect(run().status).toBe(1);
    expect(state()).toEqual(curated);
  });

  it('R1 canonical masked replay ignores row ordering and JSON whitespace', () => {
    writeInputs();
    expect(run().status).toBe(0);
    const imported = state();
    rows.reverse();
    writeInputs();
    const snapshot = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify(snapshot, null, 2));

    expect(run().report()).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 });
    expect(state()).toEqual(imported);
  });

  it('distinguishes a report-file failure from a committed import and exact replay stays safe', () => {
    writeInputs();
    const result = run(['--report-file', join(workDir, 'absent-docs', 'report.json')]);
    expect(result.status).toBe(1);
    expect(result.report()).toMatchObject({ reason: 'REPORT_WRITE_FAILED', committed: true, inserted: 2 });
    const committed = state();
    expect(run().status).toBe(0);
    expect(state()).toEqual(committed);
  });

  it('uses the migration backup path without emitting raw paths or logs', () => {
    home = join(workDir, 'upgrade-home');
    mkdirSync(home);
    const db = new DatabaseSync(join(home, 'openfleet.db'));
    const directory = new URL('../../db/migrations/', import.meta.url);
    const previous = readdirSync(directory).filter((name) => name.endsWith('.sql') && name < '026').sort().map((name) => ({ version: name.replace(/\.sql$/, ''), sql: readFileSync(new URL(name, directory), 'utf8') }));
    applyMigrations(db, previous);
    db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run('project', 'Fixture', timestamp);
    db.close();
    writeInputs();

    const result = run();

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(workDir);
    expect(result.stdout).not.toContain('database backed up');
    expect(result.report()).toMatchObject({ inserted: 2 });
    expect(readdirSync(join(home, 'backups')).some((name) => name.endsWith('.db'))).toBe(true);
  });

  it('refuses daemon-held dry-run and activation without changing authority', () => {
    manifest = { snapshot_id: 'final', frozen_at: timestamp, freeze_verified: true };
    writeInputs();
    expect(run(['--final', '--mem02-acceptance', 'MEM-02-reviewed']).status).toBe(0);
    const daemon = new DatabaseSync(join(home, 'openfleet.db'));
    daemon.prepare('SELECT * FROM projects').all();
    try {
      expect(run(['--dry-run', '--final', '--mem02-acceptance', 'MEM-02-reviewed']).report()).toMatchObject({ reason: 'DAEMON_RUNNING' });
      expect(run(['--activate', '--mem02-acceptance', 'MEM-02-reviewed']).report()).toMatchObject({ reason: 'DAEMON_RUNNING' });
      expect(daemon.prepare('SELECT authority FROM knowledge_repositories').get()).toEqual({ authority: 'frozen' });
    } finally { daemon.close(); }
  });

  it('R7 final requires independent MEM-02 acceptance and explicit sealed activation', () => {
    writeInputs();
    expect(run(['--final', '--mem02-acceptance', 'MEM-02-reviewed']).status).toBe(1);
    manifest.frozen_at = timestamp;
    writeInputs();
    expect(run(['--final', '--mem02-acceptance', 'MEM-02-reviewed']).report()).toMatchObject({ reason: 'FINAL_GATE_REQUIRED', committed: false });
    expect(state()[0]).toEqual([]);
    manifest = { snapshot_id: 'final', frozen_at: timestamp, freeze_verified: true };
    writeInputs();
    expect(run(['--final']).status).toBe(1);
    expect(run(['--final', '--mem02-acceptance', 'MEM-02-reviewed', '--dry-run']).status).toBe(0);
    expect(state()[0]).toEqual([]);
    expect(run(['--final', '--mem02-acceptance', 'MEM-02-reviewed']).status).toBe(0);
    expect(inspect((db) => db.prepare('SELECT authority FROM knowledge_repositories').get())).toEqual({ authority: 'frozen' });
    const frozen = state();
    expect(run().status).toBe(0);
    expect(state()).toEqual(frozen);
    expect(run(['--activate']).status).toBe(1);
    expect(run(['--activate', '--mem02-acceptance', 'MEM-02-reviewed']).status).toBe(0);
    expect(inspect((db) => db.prepare('SELECT authority FROM knowledge_repositories').get())).toEqual({ authority: 'native' });
    const sealed = state();
    expect(run().status).toBe(0);
    expect(state()).toEqual(sealed);
    rows[0]!.fact = 'Changed sealed content';
    writeInputs();
    expect(run(['--final', '--mem02-acceptance', 'MEM-02-reviewed']).status).toBe(1);
    expect(state()).toEqual(sealed);
  });
});
