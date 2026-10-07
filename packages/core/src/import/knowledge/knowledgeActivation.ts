import type { DatabaseSync } from 'node:sqlite';
import { KnowledgeImportError } from './knowledgeExportSchema.js';
import { readKnowledgeRegistration, type KnowledgeImportPlan } from './knowledgeImportPlan.js';
import type { KnowledgeImportReport } from './knowledgeImportReport.js';
import { runKnowledgeOperation, type KnowledgeImportOptions } from './knowledgeImporter.js';

export function activateKnowledgeSnapshot(options: KnowledgeImportOptions): Promise<KnowledgeImportReport> {
  return runKnowledgeOperation({ options: { ...options, final: true }, applyPlan: activateKnowledge });
}

export function activateKnowledge(input: { db: DatabaseSync; plan: KnowledgeImportPlan }): KnowledgeImportReport {
  const { db, plan } = input;
  if (!plan.report.success) return plan.report;
  const exactSnapshotExists = db.prepare('SELECT 1 FROM knowledge_import_runs WHERE snapshot_digest = ? AND snapshot_id = ? AND mem02_acceptance IS NOT NULL').get(plan.snapshotDigest, plan.snapshot.snapshot_id) !== undefined;
  const allRowsUnchanged = plan.report.inserted === 0 && plan.report.updated === 0;
  const allRepositoriesSealed = plan.mappings.every((mapping) => {
    const registration = readKnowledgeRegistration({ db, mapping });
    return registration !== undefined && registration.authority !== 'postgres' && registration.final_snapshot_id === plan.snapshot.snapshot_id && registration.frozen_at === plan.snapshot.frozen_at;
  });
  if (!exactSnapshotExists || !allRowsUnchanged || !allRepositoriesSealed) throw new KnowledgeImportError('SEALED_SNAPSHOT_MISMATCH');
  const activatedAt = new Date().toISOString();
  for (const mapping of plan.mappings) db.prepare(`UPDATE knowledge_repositories SET authority = 'native', activated_at = ? WHERE project_id = ? AND repo_key = ? AND authority = 'frozen'`).run(activatedAt, mapping.project_id, mapping.repo_key);
  return { ...plan.report, committed: true, repositories: plan.report.repositories.map((repo) => ({ ...repo, authority: 'native' })) };
}
