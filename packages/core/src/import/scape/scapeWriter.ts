import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from '../../db/transaction.js';
import type { EntityCounts, EntityName, ImportReport } from './importReport.js';
import type { ImportPlan, PlannedRecord } from './scapePlan.js';
import { insertRecordIfAbsent, upsertRecord, type UpsertOutcome } from './scapeTarget.js';

type Writer = (db: DatabaseSync, input: { table: string; id: string; record: PlannedRecord['record'] }) => UpsertOutcome;

interface FamilyInput<Extra> {
  db: DatabaseSync;
  entity: EntityName;
  table: string;
  planned: PlannedRecord<Extra>[];
  report: ImportReport;
  write?: Writer;
  isNotConverted?: (extra: Extra) => boolean;
}

function writeEntities<Extra>(input: FamilyInput<Extra>): void {
  const counts: EntityCounts = input.report.counts[input.entity];
  const write = input.write ?? upsertRecord;
  for (const { id, record, extra } of input.planned) {
    counts.expected++;
    counts[write(input.db, { table: input.table, id, record })]++;
    if (input.isNotConverted?.(extra)) counts.notConverted++;
  }
}

const hasUnconvertedTypes = (extra: { unconvertedTypes: string[] }) => extra.unconvertedTypes.length > 0;

function writeProjects(db: DatabaseSync, plan: ImportPlan, report: ImportReport): void {
  const keepingAnExistingDocsFolder = plan.projects.map((project) => {
    const stored = db.prepare('SELECT docs_folder_path FROM projects WHERE id = ?').get(project.id) as { docs_folder_path: string | null } | undefined;
    const docsFolderPath = project.record.docs_folder_path ?? stored?.docs_folder_path ?? null;
    return { ...project, record: { ...project.record, docs_folder_path: docsFolderPath } };
  });
  writeEntities({ db, entity: 'projects', table: 'projects', planned: keepingAnExistingDocsFolder, report });
  report.projectsWithoutDocsFolder = keepingAnExistingDocsFolder.filter((project) => project.record.docs_folder_path === null).map((project) => project.extra.projectName);
}

function writeNotes(db: DatabaseSync, plan: ImportPlan, report: ImportReport): void {
  writeEntities({ db, entity: 'notes', table: 'notes', planned: plan.notes, report, isNotConverted: hasUnconvertedTypes });
  writeEntities({ db, entity: 'noteVersions', table: 'note_versions', planned: plan.noteVersions, report, write: insertRecordIfAbsent, isNotConverted: hasUnconvertedTypes });
  for (const note of plan.notes) {
    for (const type of note.extra.unconvertedTypes) report.unconvertedNodeTypes[type] = (report.unconvertedNodeTypes[type] ?? 0) + 1;
  }
}

function writeDataStoreDefinitions(db: DatabaseSync, plan: ImportPlan, report: ImportReport): void {
  writeEntities({ db, entity: 'dataStores', table: 'data_stores', planned: plan.dataStores, report });
  writeEntities({ db, entity: 'columns', table: 'ds_columns', planned: plan.columns, report });
  writeEntities({ db, entity: 'views', table: 'ds_views', planned: plan.views, report, isNotConverted: (extra) => extra.hasDroppedFields });
  report.counts.views.expected += plan.skippedViewCount;
  report.counts.views.notConverted += plan.skippedViewCount;
}

/** One transaction per entity family: a failure rolls back its family and leaves the earlier ones committed. */
export function writePlan(db: DatabaseSync, plan: ImportPlan, report: ImportReport): void {
  inTransaction(db, 'importScapeProjects', () => writeProjects(db, plan, report));
  inTransaction(db, 'importScapeNotes', () => writeNotes(db, plan, report));
  inTransaction(db, 'importScapeDataStores', () => writeDataStoreDefinitions(db, plan, report));
  inTransaction(db, 'importScapeRows', () => writeEntities({ db, entity: 'rows', table: 'ds_rows', planned: plan.rows, report, isNotConverted: (extra) => extra.hasStaleSelectValue }));
  inTransaction(db, 'importScapeHistory', () => writeEntities({ db, entity: 'history', table: 'ds_row_history', planned: plan.history, report, write: insertRecordIfAbsent }));
}
