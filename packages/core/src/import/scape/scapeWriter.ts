import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from '../../db/transaction.js';
import type { EntityName, ImportReport } from './importReport.js';
import { ACTOR_LABEL_PREFIX, IMPORT_AUTHOR } from './scapeMappers.js';
import type { ImportPlan, PlannedRecord } from './scapePlan.js';
import { KEEP_STORED_RECORD, REPORT_DIFFERENCE_AS_CONFLICT, upsertRecord, type RecordValues, type UpsertOutcome, type WritePolicy } from './scapeTarget.js';

interface FamilyInput<Extra> {
  db: DatabaseSync;
  entity: EntityName;
  table: string;
  planned: PlannedRecord<Extra>[];
  report: ImportReport;
  policyOf: (planned: PlannedRecord<Extra>) => WritePolicy;
  isNotConverted?: (extra: Extra) => boolean;
}

function writeEntities<Extra>(input: FamilyInput<Extra>): Map<string, UpsertOutcome> {
  const counts = input.report.counts[input.entity];
  const outcomes = new Map<string, UpsertOutcome>();
  for (const planned of input.planned) {
    counts.expected++;
    const outcome = upsertRecord(input.db, { table: input.table, id: planned.id, record: planned.record, policy: input.policyOf(planned) });
    outcomes.set(planned.id, outcome);
    counts[outcome]++;
    if (input.isNotConverted?.(planned.extra)) counts.notConverted++;
  }
  return outcomes;
}

const hasUnconvertedTypes = (extra: { unconvertedTypes: string[] }) => extra.unconvertedTypes.length > 0;
const wasWrittenByTheImporter = (stored: RecordValues) => stored.author === IMPORT_AUTHOR;

function hasOpenFleetSideVersion(db: DatabaseSync, noteId: string): boolean {
  return db.prepare('SELECT 1 FROM note_versions WHERE note_id = ? AND author <> ? LIMIT 1').get(noteId, IMPORT_AUTHOR) !== undefined;
}

function hasHistoryFromOpenFleet(db: DatabaseSync, rowId: string): boolean {
  return db.prepare(`SELECT 1 FROM ds_row_history WHERE row_id = ? AND actor_label NOT LIKE ? LIMIT 1`).get(rowId, `${ACTOR_LABEL_PREFIX}%`) !== undefined;
}

function hasRowDeletedInOpenFleet(db: DatabaseSync, rowId: string): boolean {
  const deletion = db.prepare(`SELECT 1 FROM ds_row_history WHERE row_id = ? AND actor_label NOT LIKE ? AND json_extract(change_json, '$.kind') = 'delete' LIMIT 1`).get(rowId, `${ACTOR_LABEL_PREFIX}%`);
  return deletion !== undefined;
}

function writeProjects(db: DatabaseSync, plan: ImportPlan, report: ImportReport): void {
  const keepingAnExistingDocsFolder = plan.projects.map((project) => {
    const stored = db.prepare('SELECT docs_folder_path FROM projects WHERE id = ?').get(project.id) as { docs_folder_path: string | null } | undefined;
    const docsFolderPath = stored?.docs_folder_path ?? project.record.docs_folder_path ?? null;
    return { ...project, record: { ...project.record, docs_folder_path: docsFolderPath } };
  });
  writeEntities({
    db, entity: 'projects', table: 'projects', planned: keepingAnExistingDocsFolder, report,
    policyOf: (project) => ({ decideOnDifference: (stored) => (stored.name === project.record.name ? 'overwrite' : 'conflict') }),
  });
  report.projectsWithoutDocsFolder = keepingAnExistingDocsFolder.filter((project) => project.record.docs_folder_path === null).map((project) => project.extra.projectName);
}

/** A note OpenFleet moved forward (higher rev) or edited (a version by someone else) is never rewritten: its rev must not go down. */
const noteEditedInOpenFleet = (db: DatabaseSync, note: PlannedRecord) => (stored: RecordValues) =>
  Number(stored.rev) > Number(note.record.rev) || hasOpenFleetSideVersion(db, note.id);

function removeStaleCurrentVersions(db: DatabaseSync, note: PlannedRecord<{ currentVersionId: string }>): void {
  db.prepare(`DELETE FROM note_versions WHERE note_id = ? AND author = ? AND id LIKE ? AND id <> ?`).run(note.id, IMPORT_AUTHOR, `${note.id}@rev%`, note.extra.currentVersionId);
}

function writeNotes(db: DatabaseSync, plan: ImportPlan, report: ImportReport): void {
  const noteOutcomes = writeEntities({
    db, entity: 'notes', table: 'notes', planned: plan.notes, report, isNotConverted: hasUnconvertedTypes,
    policyOf: (note) => ({ decideOnDifference: (stored) => (noteEditedInOpenFleet(db, note)(stored) ? 'conflict' : 'overwrite') }),
  });
  plan.notes.filter((note) => noteOutcomes.get(note.id) === 'updated').forEach((note) => removeStaleCurrentVersions(db, note));

  const versionsOfNotesLeftAlone = plan.noteVersions.filter((version) => noteOutcomes.get(String(version.record.note_id)) === 'conflict');
  const versionsToWrite = plan.noteVersions.filter((version) => !versionsOfNotesLeftAlone.includes(version));
  const versionCounts = report.counts.noteVersions;
  versionCounts.expected += versionsOfNotesLeftAlone.length;
  versionCounts.conflict += versionsOfNotesLeftAlone.length;
  writeEntities({
    db, entity: 'noteVersions', table: 'note_versions', planned: versionsToWrite, report, isNotConverted: hasUnconvertedTypes,
    policyOf: () => ({ decideOnDifference: (stored) => (wasWrittenByTheImporter(stored) ? 'overwrite' : 'conflict') }),
  });
  for (const note of plan.notes) {
    for (const type of note.extra.unconvertedTypes) report.unconvertedNodeTypes[type] = (report.unconvertedNodeTypes[type] ?? 0) + 1;
  }
}

function writeDataStoreDefinitions(db: DatabaseSync, plan: ImportPlan, report: ImportReport): void {
  writeEntities({
    db, entity: 'dataStores', table: 'data_stores', planned: plan.dataStores, report,
    policyOf: (store) => ({ decideOnDifference: (stored) => (String(stored.updated_at) <= String(store.record.updated_at) ? 'overwrite' : 'conflict') }),
  });
  writeEntities({ db, entity: 'columns', table: 'ds_columns', planned: plan.columns, report, policyOf: () => REPORT_DIFFERENCE_AS_CONFLICT });
  writeEntities({ db, entity: 'views', table: 'ds_views', planned: plan.views, report, policyOf: () => REPORT_DIFFERENCE_AS_CONFLICT, isNotConverted: (extra) => extra.hasDroppedFields });
  report.counts.views.expected += plan.skippedViewCount;
  report.counts.views.notConverted += plan.skippedViewCount;
}

function writeRows(db: DatabaseSync, plan: ImportPlan, report: ImportReport): void {
  writeEntities({
    db, entity: 'rows', table: 'ds_rows', planned: plan.rows, report, isNotConverted: (extra) => extra.hasStaleSelectValue,
    policyOf: (row) => ({
      canInsert: () => !hasRowDeletedInOpenFleet(db, row.id),
      decideOnDifference: (stored) => {
        const isNewerInOpenFleet = String(stored.updated_at) > String(row.record.updated_at);
        return isNewerInOpenFleet || hasHistoryFromOpenFleet(db, row.id) ? 'conflict' : 'overwrite';
      },
    }),
  });
}

function writeHistory(db: DatabaseSync, plan: ImportPlan, report: ImportReport): void {
  writeEntities({ db, entity: 'history', table: 'ds_row_history', planned: plan.history, report, policyOf: () => KEEP_STORED_RECORD });
  report.counts.history.expected += plan.skippedHistoryCount;
  report.counts.history.notConverted += plan.skippedHistoryCount;
}

/** The whole write phase is one transaction, each entity family a savepoint inside it: any failure undoes the run. */
export function writePlan(db: DatabaseSync, plan: ImportPlan, report: ImportReport, beforeCommit: () => void): void {
  inTransaction(db, 'importScape', () => {
    inTransaction(db, 'importScapeProjects', () => writeProjects(db, plan, report));
    inTransaction(db, 'importScapeNotes', () => writeNotes(db, plan, report));
    inTransaction(db, 'importScapeDataStores', () => writeDataStoreDefinitions(db, plan, report));
    inTransaction(db, 'importScapeRows', () => writeRows(db, plan, report));
    inTransaction(db, 'importScapeHistory', () => writeHistory(db, plan, report));
    beforeCommit();
  });
}
