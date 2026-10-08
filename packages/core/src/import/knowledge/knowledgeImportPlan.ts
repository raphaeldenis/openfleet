import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { KnowledgeAuthority } from '../../knowledge/knowledgeTypes.js';
import { isWellFormedUnicode, KnowledgeImportError, type KnowledgeExport, type KnowledgeExportRow } from './knowledgeExportSchema.js';
import { assertMappingProjects, assertMappingRepositories, mappingIdentity, type KnowledgeMapping } from './knowledgeMapping.js';
import { emptyKnowledgeCounts, type KnowledgeCounts, type KnowledgeImportReport } from './knowledgeImportReport.js';

export const storedFactColumns = ['area', 'fact', 'source_task', 'source_kind', 'verified_by', 'created_at', 'retired_at', 'retired_why'] as const;
export type StoredKnowledgeFields = Pick<KnowledgeExportRow, typeof storedFactColumns[number]>;

export interface PlannedKnowledgeRow {
  source: KnowledgeExportRow;
  mapping: KnowledgeMapping;
  id: string;
  fingerprint: string;
  outcome: 'inserted' | 'updated' | 'unchanged' | 'conflicts';
}

export interface KnowledgeImportPlan {
  snapshot: KnowledgeExport;
  mappings: KnowledgeMapping[];
  rows: PlannedKnowledgeRow[];
  snapshotDigest: string;
  report: KnowledgeImportReport;
  changesAuthority: boolean;
  createsRepository: boolean;
}

interface ImportedEntry { source_id: string; knowledge_id: string; imported_fingerprint: string; snapshot_id: string }
export interface StoredKnowledgeRepository extends KnowledgeMapping { frozen_at: string | null; final_snapshot_id: string | null; activated_at: string | null }

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeIdentity = (scope: { project_id: string; repo_key: string }) => JSON.stringify([scope.project_id, scope.repo_key]);
const nativeId = (input: { mapping: KnowledgeMapping; sourceId: string }) => `pg:${[input.mapping.project_id, input.mapping.repo_key, input.sourceId].map((part) => Buffer.from(part).toString('base64url')).join(':')}`;

export function knowledgeFingerprint(input: { fields: StoredKnowledgeFields; mapping: KnowledgeMapping }): string {
  const canonicalFields = storedFactColumns.map((column) => input.fields[column]);
  return digest([mappingIdentity(input.mapping), canonicalFields]);
}

export function readKnowledgeRegistration(input: { db: DatabaseSync; mapping: KnowledgeMapping }): StoredKnowledgeRepository | undefined {
  return input.db.prepare('SELECT * FROM knowledge_repositories WHERE project_id = ? AND repo_key = ?').get(input.mapping.project_id, input.mapping.repo_key) as StoredKnowledgeRepository | undefined;
}

function registrationMatches(input: { stored: StoredKnowledgeRepository; mapping: KnowledgeMapping }): boolean {
  return input.stored.canonical_root === input.mapping.canonical_root && input.stored.git_common_dir === input.mapping.git_common_dir;
}

function rowOutcome(input: { db: DatabaseSync; row: PlannedKnowledgeRow; entry: ImportedEntry | undefined }): PlannedKnowledgeRow['outcome'] {
  const { db, row, entry } = input;
  const stored = db.prepare('SELECT * FROM knowledge WHERE id = ?').get(row.id) as (StoredKnowledgeFields & { project_id: string; repo_key: string }) | undefined;
  if (entry === undefined) {
    const targetAlreadyExists = stored !== undefined;
    return targetAlreadyExists ? 'conflicts' : 'inserted';
  }
  const targetIdentityChanges = entry.knowledge_id !== row.id;
  if (stored === undefined || targetIdentityChanges) return 'conflicts';
  const targetScopeMatches = scopeIdentity(stored) === scopeIdentity(row.mapping);
  if (!targetScopeMatches) return 'conflicts';
  const storedFingerprint = knowledgeFingerprint({ fields: stored, mapping: row.mapping });
  const targetRemainsImported = storedFingerprint === entry.imported_fingerprint;
  if (!targetRemainsImported) return 'conflicts';
  const sourceMatchesTarget = storedFingerprint === row.fingerprint;
  return sourceMatchesTarget ? 'unchanged' : 'updated';
}

function snapshotDigest(input: { snapshot: KnowledgeExport; mappings: KnowledgeMapping[]; rows: PlannedKnowledgeRow[] }): string {
  const repos = input.mappings.map(mappingIdentity).sort((left, right) => compareCanonicalStrings({ left: JSON.stringify(left), right: JSON.stringify(right) }));
  const rows = input.rows.map((row) => [row.id, row.fingerprint]).sort((left, right) => compareCanonicalStrings({ left: left[0]!, right: right[0]! }));
  const { version, source, snapshot_id, exported_at, frozen_at, freeze_verified } = input.snapshot;
  return digest([{ version, source, snapshot_id, exported_at, frozen_at, freeze_verified }, repos, rows]);
}

function compareCanonicalStrings(input: { left: string; right: string }): number {
  if (input.left === input.right) return 0;
  return input.left < input.right ? -1 : 1;
}

function countRepository(input: { rows: PlannedKnowledgeRow[]; entries: ImportedEntry[]; authority: KnowledgeAuthority; repository: number }): KnowledgeImportReport['repositories'][number] {
  const counts = emptyKnowledgeCounts();
  const sourceIds = new Set(input.rows.map((row) => row.source.id));
  for (const row of input.rows) {
    counts.source_rows += 1;
    if (row.source.retired_at === null) counts.source_active += 1;
    else counts.source_retired += 1;
    counts[row.outcome] += 1;
  }
  counts.missing_source = input.entries.filter((entry) => !sourceIds.has(entry.source_id)).length;
  counts.conflicts += counts.missing_source;
  return { ...counts, repository: input.repository, authority: input.authority };
}

function totalCounts(repositories: KnowledgeImportReport['repositories']): KnowledgeCounts {
  const total = emptyKnowledgeCounts();
  for (const repo of repositories) for (const key of Object.keys(total) as (keyof KnowledgeCounts)[]) total[key] += repo[key];
  return total;
}

interface PlanInput { db: DatabaseSync; snapshot: KnowledgeExport; mappings: KnowledgeMapping[]; dryRun: boolean; final: boolean }
interface RepositoryPlan {
  rows: PlannedKnowledgeRow[];
  counts: KnowledgeImportReport['repositories'][number];
  createsRepository: boolean;
  changesAuthority: boolean;
  requiresExactSnapshot: boolean;
  nativeSnapshotChanges: boolean;
}

function sourceRowsByRepository(rows: KnowledgeExportRow[]): Map<string, KnowledgeExportRow[]> {
  const grouped = new Map<string, KnowledgeExportRow[]>();
  for (const row of rows) {
    const repoRows = grouped.get(row.repo) ?? [];
    repoRows.push(row);
    grouped.set(row.repo, repoRows);
  }
  return grouped;
}

function planRows(input: { db: DatabaseSync; mapping: KnowledgeMapping; sourceRows: KnowledgeExportRow[]; entries: ImportedEntry[] }): PlannedKnowledgeRow[] {
  const entriesById = new Map(input.entries.map((entry) => [entry.source_id, entry]));
  return input.sourceRows.map((source) => {
    const row: PlannedKnowledgeRow = { source, mapping: input.mapping, id: nativeId({ mapping: input.mapping, sourceId: source.id }), fingerprint: knowledgeFingerprint({ fields: source, mapping: input.mapping }), outcome: 'inserted' };
    row.outcome = rowOutcome({ db: input.db, row, entry: entriesById.get(source.id) });
    return row;
  });
}

function importMappingConflicts(input: { db: DatabaseSync; mapping: KnowledgeMapping; entries: ImportedEntry[] }): number {
  const previousMappings = input.db.prepare('SELECT DISTINCT project_id, repo_key, canonical_root, git_common_dir FROM knowledge_import_mappings WHERE source_repo = ?').all(input.mapping.source_repo) as unknown as KnowledgeMapping[];
  const sourceRepositoryRemaps = previousMappings.some((previous) => {
    const projectOrKeyChanges = scopeIdentity(previous) !== scopeIdentity(input.mapping);
    const rootChanges = previous.canonical_root !== input.mapping.canonical_root;
    const repositoryChanges = previous.git_common_dir !== input.mapping.git_common_dir;
    return projectOrKeyChanges || rootChanges || repositoryChanges;
  });
  const lacksImportProvenance = input.entries.length > 0 && previousMappings.length === 0;
  return sourceRepositoryRemaps || lacksImportProvenance ? 1 : 0;
}

function targetScopeConflicts(input: { db: DatabaseSync; mapping: KnowledgeMapping; stored: StoredKnowledgeRepository | undefined }): number {
  const { db, mapping, stored } = input;
  const registrationRemaps = stored !== undefined && !registrationMatches({ stored, mapping });
  const duplicateGitScope = db.prepare('SELECT repo_key FROM knowledge_repositories WHERE project_id = ? AND git_common_dir = ? AND repo_key <> ?').get(mapping.project_id, mapping.git_common_dir, mapping.repo_key) !== undefined;
  const hasUntrackedTarget = db.prepare(`SELECT 1 FROM knowledge k WHERE k.project_id = ? AND k.repo_key = ? AND NOT EXISTS (SELECT 1 FROM knowledge_import_entries e WHERE e.knowledge_id = k.id) LIMIT 1`).get(mapping.project_id, mapping.repo_key) !== undefined;
  return [registrationRemaps || duplicateGitScope, hasUntrackedTarget].filter(Boolean).length;
}

function finalSealChanges(input: { final: boolean; snapshot: KnowledgeExport; stored: StoredKnowledgeRepository | undefined }): boolean {
  const isNative = input.stored?.authority === 'native';
  const hasNoFinalSeal = input.stored?.authority === 'postgres' || input.stored === undefined;
  const snapshotChanges = input.stored?.final_snapshot_id !== input.snapshot.snapshot_id;
  const freezeChanges = input.stored?.frozen_at !== input.snapshot.frozen_at;
  return input.final && !isNative && (hasNoFinalSeal || snapshotChanges || freezeChanges);
}

function nativeSnapshotChanges(input: { stored: StoredKnowledgeRepository | undefined; snapshot: KnowledgeExport; rows: PlannedKnowledgeRow[]; counts: KnowledgeCounts }): boolean {
  if (input.stored?.authority !== 'native') return false;
  const sealChanges = input.stored.final_snapshot_id !== input.snapshot.snapshot_id || input.stored.frozen_at !== input.snapshot.frozen_at;
  const importedContentChanges = input.rows.some((row) => row.outcome !== 'unchanged');
  return sealChanges || importedContentChanges || input.counts.conflicts > 0;
}

function planRepository(input: PlanInput & { mapping: KnowledgeMapping; repository: number; sourceRows: KnowledgeExportRow[] }): RepositoryPlan {
  const { db, mapping } = input;
  const stored = readKnowledgeRegistration({ db, mapping });
  const authority = stored?.authority ?? 'postgres';
  const entries = db.prepare('SELECT * FROM knowledge_import_entries WHERE project_id = ? AND repo_key = ?').all(mapping.project_id, mapping.repo_key) as unknown as ImportedEntry[];
  const rows = planRows({ db, mapping, entries, sourceRows: input.sourceRows });
  const counts = countRepository({ rows, entries, authority, repository: input.repository });
  counts.missing_target = entries.filter((entry) => db.prepare('SELECT 1 FROM knowledge WHERE id = ?').get(entry.knowledge_id) === undefined).length;
  counts.conflicts += importMappingConflicts({ db, mapping, entries });
  counts.conflicts += targetScopeConflicts({ db, mapping, stored });
  const changesAuthority = finalSealChanges({ final: input.final, snapshot: input.snapshot, stored });
  if (changesAuthority) counts.authority = 'frozen';
  const requiresExactSnapshot = authority === 'native' || (authority === 'frozen' && !input.final);
  return { rows, counts, changesAuthority, createsRepository: stored === undefined, requiresExactSnapshot, nativeSnapshotChanges: nativeSnapshotChanges({ stored, snapshot: input.snapshot, rows, counts }) };
}

function planRejection(input: { sealedMismatch: boolean; success: boolean }): KnowledgeImportReport['reason'] {
  if (input.sealedMismatch) return 'SEALED_SNAPSHOT_MISMATCH';
  return input.success ? null : 'CONFLICT';
}

export function matchesCurrentKnowledgeSeal(input: { db: DatabaseSync; mappings: KnowledgeMapping[]; snapshotDigest: string }): boolean {
  return input.mappings.every((mapping) => {
    const currentSeal = input.db.prepare(`SELECT 1 FROM knowledge_current_seals s
      JOIN knowledge_import_runs r ON r.id = s.run_id
      WHERE s.project_id = ? AND s.repo_key = ? AND r.snapshot_digest = ?
        AND r.mem02_acceptance IS NOT NULL`).get(mapping.project_id, mapping.repo_key, input.snapshotDigest);
    return currentSeal !== undefined;
  });
}

function sealMismatch(input: { repoPlans: RepositoryPlan[]; matchesCurrentSeal: boolean }): boolean {
  const nativeContentChanges = input.repoPlans.some((repo) => repo.nativeSnapshotChanges);
  const requiresExactSnapshot = input.repoPlans.some((repo) => repo.requiresExactSnapshot);
  const requiredSealChanges = requiresExactSnapshot && !input.matchesCurrentSeal;
  return nativeContentChanges || requiredSealChanges;
}

function countsReconcile(counts: KnowledgeCounts): boolean {
  const reconcilesEverySource = counts.source_rows === counts.inserted + counts.updated + counts.unchanged;
  const retirementCountsMatch = counts.source_active + counts.source_retired === counts.source_rows;
  return counts.conflicts === 0 && reconcilesEverySource && retirementCountsMatch;
}

export function buildKnowledgeImportPlan(input: PlanInput): KnowledgeImportPlan {
  assertMappingProjects(input);
  assertMappingRepositories(input.mappings);
  const sourceRows = sourceRowsByRepository(input.snapshot.rows);
  const repoPlans = input.mappings.map((mapping, repository) => planRepository({ ...input, mapping, repository, sourceRows: sourceRows.get(mapping.source_repo) ?? [] }));
  const rows = repoPlans.flatMap((repo) => repo.rows);
  const repositories = repoPlans.map((repo) => repo.counts);
  const sealedDigest = snapshotDigest({ ...input, rows });
  const matchesCurrentSeal = matchesCurrentKnowledgeSeal({ db: input.db, mappings: input.mappings, snapshotDigest: sealedDigest });
  const sealedMismatch = sealMismatch({ repoPlans, matchesCurrentSeal });
  const counts = totalCounts(repositories);
  const success = !sealedMismatch && countsReconcile(counts);
  const report: KnowledgeImportReport = { ...counts, success, reason: planRejection({ sealedMismatch, success }), dry_run: input.dryRun, committed: false, schema_upgraded: false, repositories };
  return { snapshot: input.snapshot, mappings: input.mappings, rows, snapshotDigest: sealedDigest, report, changesAuthority: repoPlans.some((repo) => repo.changesAuthority), createsRepository: repoPlans.some((repo) => repo.createsRepository) };
}

export function assertFinalGate(input: { snapshot: KnowledgeExport; acceptance: string | undefined }): void {
  const hasOperatorAcceptance = input.acceptance !== undefined && input.acceptance.trim().length > 0 && Buffer.byteLength(input.acceptance) <= 512 && isWellFormedUnicode(input.acceptance) && !/[\p{Cc}\p{Cf}]/u.test(input.acceptance);
  const hasVerifiedFreeze = input.snapshot.freeze_verified && input.snapshot.frozen_at !== null && input.snapshot.frozen_at <= input.snapshot.exported_at;
  if (!hasOperatorAcceptance || !hasVerifiedFreeze) throw new KnowledgeImportError('FINAL_GATE_REQUIRED');
}
