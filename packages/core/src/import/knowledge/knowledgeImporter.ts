import { existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../db/database.js';
import { assertBootableSchema, pendingMigrations } from '../../db/migrate.js';
import { inTransaction } from '../../db/transaction.js';
import { maskedSecrets } from '../../redact.js';
import { assertNoOtherProcessHolds, openWritableTarget } from '../scape/scapeTarget.js';
import { ScapeImportError } from '../scape/scapeImportError.js';
import { assertNoSymlink, KnowledgeImportError, parseKnowledgeExport, readKnowledgeJson } from './knowledgeExportSchema.js';
import { assertMappingProjects, resolveKnowledgeMapping, type KnowledgeMapping } from './knowledgeMapping.js';
import { assertFinalGate, buildKnowledgeImportPlan, storedFactColumns, type KnowledgeImportPlan } from './knowledgeImportPlan.js';
import { assertReportTarget, persistKnowledgeReport, rejectedKnowledgeReport, type KnowledgeImportReport } from './knowledgeImportReport.js';

export interface KnowledgeImportOptions {
  home: string;
  file: string;
  mappingFile: string;
  reportFile?: string;
  dryRun: boolean;
  final: boolean;
  mem02Acceptance?: string;
}

function assertExistingProjects(input: { home: string; mappings: KnowledgeMapping[] }): void {
  const path = join(input.home, 'openfleet.db');
  if (!existsSync(path)) throw new KnowledgeImportError('UNKNOWN_PROJECT');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assertBootableSchema(db, path);
    assertMappingProjects({ db, mappings: input.mappings });
  } finally { db.close(); }
}

function openReadOnlyTarget(home: string): { db: DatabaseSync; dispose(): void } {
  const path = join(home, 'openfleet.db');
  assertNoOtherProcessHolds(path);
  const db = existsSync(path) ? new DatabaseSync(path, { readOnly: true }) : openDatabase(':memory:');
  try {
    assertBootableSchema(db, path);
    if (pendingMigrations(db).length > 0) throw new KnowledgeImportError('TARGET_UNAVAILABLE');
    return { db, dispose: () => db.close() };
  } catch (error) { db.close(); throw error; }
}

function retainExclusiveAccess(db: DatabaseSync): void {
  try {
    db.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE');
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (error) {
    const sqliteError = error as { errcode?: number };
    const primaryCode = (sqliteError.errcode ?? 0) & 255;
    if (primaryCode === 5 || primaryCode === 6) throw new KnowledgeImportError('DAEMON_RUNNING');
    throw error;
  }
}

function registerRepositories(input: { db: DatabaseSync; plan: KnowledgeImportPlan; final: boolean }): void {
  for (const mapping of input.plan.mappings) {
    input.db.prepare(`INSERT INTO knowledge_repositories (project_id, repo_key, canonical_root, git_common_dir) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, repo_key) DO NOTHING`).run(mapping.project_id, mapping.repo_key, mapping.canonical_root, mapping.git_common_dir);
    if (!input.final) continue;
    input.db.prepare(`UPDATE knowledge_repositories SET authority = 'frozen', frozen_at = ?, final_snapshot_id = ? WHERE project_id = ? AND repo_key = ? AND authority <> 'native'`).run(input.plan.snapshot.frozen_at, input.plan.snapshot.snapshot_id, mapping.project_id, mapping.repo_key);
  }
}

function writeImportedRows(input: { db: DatabaseSync; plan: KnowledgeImportPlan }): void {
  const { db, plan } = input;
  const insertFact = db.prepare(`INSERT INTO knowledge (id, project_id, repo_key, ${storedFactColumns.join(', ')}) VALUES (${Array.from({ length: storedFactColumns.length + 3 }, () => '?').join(', ')})`);
  const updateFact = db.prepare(`UPDATE knowledge SET ${storedFactColumns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`);
  const remember = db.prepare(`INSERT INTO knowledge_import_entries (project_id, repo_key, source_id, knowledge_id, imported_fingerprint, snapshot_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (project_id, repo_key, source_id) DO UPDATE SET imported_fingerprint = excluded.imported_fingerprint, snapshot_id = excluded.snapshot_id`);
  for (const row of plan.rows) {
    if (row.outcome === 'unchanged') continue;
    const fields = storedFactColumns.map((column) => row.source[column]);
    if (row.outcome === 'inserted') insertFact.run(row.id, row.mapping.project_id, row.mapping.repo_key, ...fields);
    if (row.outcome === 'updated') updateFact.run(...fields, row.id);
    remember.run(row.mapping.project_id, row.mapping.repo_key, row.source.id, row.id, row.fingerprint, plan.snapshot.snapshot_id);
  }
}

function writeImport(input: { db: DatabaseSync; plan: KnowledgeImportPlan; final: boolean; mem02Acceptance?: string }): KnowledgeImportReport {
  const { db, plan } = input;
  if (!plan.report.success) return plan.report;
  const exactRunExists = db.prepare('SELECT 1 FROM knowledge_import_runs WHERE snapshot_digest = ?').get(plan.snapshotDigest) !== undefined;
  const hasChanges = plan.report.inserted + plan.report.updated > 0 || plan.changesAuthority || plan.createsRepository || !exactRunExists;
  if (!hasChanges) return { ...plan.report, committed: true };
  registerRepositories(input);
  writeImportedRows(input);
  const runId = randomUUID();
  const mem02Acceptance = input.final && input.mem02Acceptance !== undefined ? maskedSecrets(input.mem02Acceptance) : null;
  db.prepare(`INSERT INTO knowledge_import_runs (id, snapshot_id, imported_at, source_rows, inserted, updated, unchanged, retired, snapshot_digest, mem02_acceptance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(runId, plan.snapshot.snapshot_id, new Date().toISOString(), plan.report.source_rows, plan.report.inserted, plan.report.updated, plan.report.unchanged, plan.report.source_retired, plan.snapshotDigest, mem02Acceptance);
  const recordMapping = db.prepare('INSERT INTO knowledge_import_mappings (run_id, source_repo, project_id, repo_key, canonical_root, git_common_dir) VALUES (?, ?, ?, ?, ?, ?)');
  for (const mapping of plan.mappings) recordMapping.run(runId, mapping.source_repo, mapping.project_id, mapping.repo_key, mapping.canonical_root, mapping.git_common_dir);
  return { ...plan.report, committed: true };
}

function refusalReason(error: unknown): KnowledgeImportError['reason'] {
  if (error instanceof KnowledgeImportError) return error.reason;
  if (error instanceof ScapeImportError && error.code === 'DAEMON_RUNNING') return 'DAEMON_RUNNING';
  return 'IMPORT_WRITE_FAILED';
}

function assertSeparateReportTarget(options: KnowledgeImportOptions): void {
  if (options.reportFile === undefined) return;
  assertReportTarget(options.reportFile);
  const targetStatePaths = ['openfleet.db', 'openfleet.db-wal', 'openfleet.db-shm', 'config.json'].map((name) => join(options.home, name));
  const protectedPaths = [options.file, options.mappingFile, ...targetStatePaths];
  const reportFile = existsSync(options.reportFile) ? statSync(options.reportFile) : undefined;
  for (const path of protectedPaths) {
    const samePath = resolve(path) === resolve(options.reportFile);
    const protectedFile = reportFile !== undefined && existsSync(path) ? statSync(path) : undefined;
    const sameInode = protectedFile !== undefined && reportFile !== undefined && protectedFile.dev === reportFile.dev && protectedFile.ino === reportFile.ino;
    if (samePath || sameInode) throw new KnowledgeImportError('REPORT_WRITE_FAILED');
  }
}

export function importKnowledge(options: KnowledgeImportOptions): Promise<KnowledgeImportReport> {
  return runKnowledgeOperation({ options, applyPlan: writeImport });
}

interface KnowledgeWriteInput { db: DatabaseSync; plan: KnowledgeImportPlan; final: boolean; mem02Acceptance?: string }

function reportAfterFailure(input: { report: KnowledgeImportReport | undefined; reason: KnowledgeImportError['reason']; dryRun: boolean }): KnowledgeImportReport {
  const { report, reason } = input;
  if (report === undefined) return rejectedKnowledgeReport({ reason, dryRun: input.dryRun });
  if (report.committed) return { ...report, success: false, reason };
  const repositories = report.repositories.map((repo) => ({ ...repo, inserted: 0, updated: 0, unchanged: 0, rejected: repo.source_rows }));
  return { ...report, success: false, reason, committed: false, inserted: 0, updated: 0, unchanged: 0, rejected: report.source_rows, repositories };
}

export async function runKnowledgeOperation(input: { options: KnowledgeImportOptions; applyPlan(input: KnowledgeWriteInput): KnowledgeImportReport }): Promise<KnowledgeImportReport> {
  const { options } = input;
  let target: { db: DatabaseSync; dispose(): void } | undefined;
  let report: KnowledgeImportReport | undefined;
  try {
    assertNoSymlink(options.home);
    assertNoSymlink(join(options.home, 'openfleet.db'));
    assertSeparateReportTarget(options);
    const snapshot = parseKnowledgeExport(readKnowledgeJson(options.file));
    const mappings = await resolveKnowledgeMapping({ mapping: readKnowledgeJson(options.mappingFile), sourceRepos: snapshot.repos.map((repo) => repo.repo) });
    if (options.final) assertFinalGate({ snapshot, acceptance: options.mem02Acceptance });
    if (!options.dryRun) assertExistingProjects({ home: options.home, mappings });
    target = options.dryRun ? openReadOnlyTarget(options.home) : openWritableTarget(options.home, { migrationLogging: 'silent' });
    if (!options.dryRun) retainExclusiveAccess(target.db);
    const db = target.db;
    const planInput = { db, snapshot, mappings, dryRun: options.dryRun, final: options.final };
    if (options.dryRun) {
      report = buildKnowledgeImportPlan(planInput).report;
    } else {
      report = inTransaction(db, 'importKnowledgeSnapshot', () => {
        const plan = buildKnowledgeImportPlan(planInput);
        report = plan.report;
        return input.applyPlan({ db, plan, final: options.final, mem02Acceptance: options.mem02Acceptance });
      }, { failureLogging: 'silent' });
    }
    const savesReport = options.reportFile !== undefined && report.success && !options.dryRun;
    if (savesReport) {
      assertSeparateReportTarget(options);
      persistKnowledgeReport({ path: options.reportFile!, report });
    }
  } catch (error) {
    report = reportAfterFailure({ report, reason: refusalReason(error), dryRun: options.dryRun });
  } finally {
    try { target?.dispose(); }
    catch { report = reportAfterFailure({ report, reason: 'IMPORT_WRITE_FAILED', dryRun: options.dryRun }); }
  }
  return report;
}
