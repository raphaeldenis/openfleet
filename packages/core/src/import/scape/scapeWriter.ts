import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from '../../db/transaction.js';
import type { EntityName, ImportReport } from './importReport.js';
import { ACTOR_LABEL_PREFIX, IMPORT_AUTHOR } from './scapeMappers.js';
import type { ImportPlan, PlannedRecord } from './scapePlan.js';
import { writeManagers } from './scapeManagersWriter.js';
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

// The prefix is compared by position, so the match is case sensitive (LIKE would ignore case).
const NOT_WRITTEN_BY_THE_IMPORTER = `substr(actor_label, 1, ${ACTOR_LABEL_PREFIX.length}) <> ?`;

function hasOpenFleetSideVersion(db: DatabaseSync, noteId: string): boolean {
  return db.prepare('SELECT 1 FROM note_versions WHERE note_id = ? AND author <> ? LIMIT 1').get(noteId, IMPORT_AUTHOR) !== undefined;
}

function hasHistoryFromOpenFleet(db: DatabaseSync, rowId: string): boolean {
  return db.prepare(`SELECT 1 FROM ds_row_history WHERE row_id = ? AND ${NOT_WRITTEN_BY_THE_IMPORTER} LIMIT 1`).get(rowId, ACTOR_LABEL_PREFIX) !== undefined;
}

function hasRowDeletedInOpenFleet(db: DatabaseSync, rowId: string): boolean {
  const deletion = db
    .prepare(`SELECT 1 FROM ds_row_history WHERE row_id = ? AND ${NOT_WRITTEN_BY_THE_IMPORTER} AND json_extract(change_json, '$.kind') = 'delete' LIMIT 1`)
    .get(rowId, ACTOR_LABEL_PREFIX);
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

const isStored = (db: DatabaseSync, table: string, id: string) => db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;

/** The stores whose own record or one of whose columns could not be created because OpenFleet holds the name: nothing may hang on them. */
function storesBlockedByANameCollision(db: DatabaseSync, plan: ImportPlan): Set<string> {
  const missingStores = plan.dataStores.filter((store) => !isStored(db, 'data_stores', store.id)).map((store) => store.id);
  const storesMissingAColumn = plan.columns.filter((column) => !isStored(db, 'ds_columns', column.id)).map((column) => String(column.record.store_id));
  return new Set([...missingStores, ...storesMissingAColumn]);
}

function writeDataStoreDefinitions(db: DatabaseSync, plan: ImportPlan, report: ImportReport): Set<string> {
  writeEntities({
    db, entity: 'dataStores', table: 'data_stores', planned: plan.dataStores, report,
    policyOf: (store) => ({ decideOnDifference: (stored) => (String(stored.updated_at) <= String(store.record.updated_at) ? 'overwrite' : 'conflict') }),
  });
  const storesWithoutRecord = new Set(plan.dataStores.filter((store) => !isStored(db, 'data_stores', store.id)).map((store) => store.id));
  const onlyWhereTheStoreExists = (planned: PlannedRecord): WritePolicy => ({
    ...REPORT_DIFFERENCE_AS_CONFLICT,
    canInsert: () => !storesWithoutRecord.has(String(planned.record.store_id)),
  });
  writeEntities({ db, entity: 'columns', table: 'ds_columns', planned: plan.columns, report, policyOf: onlyWhereTheStoreExists });
  writeEntities({ db, entity: 'views', table: 'ds_views', planned: plan.views, report, policyOf: onlyWhereTheStoreExists, isNotConverted: (extra) => extra.hasDroppedFields });
  report.counts.views.expected += plan.skippedViewCount;
  report.counts.views.notConverted += plan.skippedViewCount;
  return storesBlockedByANameCollision(db, plan);
}

function writeRows(db: DatabaseSync, plan: ImportPlan, report: ImportReport, blockedStores: Set<string>): Map<string, UpsertOutcome> {
  return writeEntities({
    db, entity: 'rows', table: 'ds_rows', planned: plan.rows, report, isNotConverted: (extra) => extra.hasStaleSelectValue,
    policyOf: (row) => {
      const isBlocked = blockedStores.has(String(row.record.store_id));
      return {
        canInsert: () => !isBlocked && !hasRowDeletedInOpenFleet(db, row.id),
        decideOnDifference: (stored) => {
          const isNewerInOpenFleet = String(stored.updated_at) > String(row.record.updated_at);
          return isBlocked || isNewerInOpenFleet || hasHistoryFromOpenFleet(db, row.id) ? 'conflict' : 'overwrite';
        },
      };
    },
  });
}

function writeHistory(db: DatabaseSync, plan: ImportPlan, report: ImportReport, input: { blockedStores: Set<string>; rowOutcomes: Map<string, UpsertOutcome> }): void {
  writeEntities({
    db, entity: 'history', table: 'ds_row_history', planned: plan.history, report,
    policyOf: (entry) => {
      const isOfABlockedStore = input.blockedStores.has(String(entry.record.store_id));
      const isOfARowLeftAlone = input.rowOutcomes.get(String(entry.record.row_id)) === 'conflict';
      return { ...KEEP_STORED_RECORD, canInsert: () => !isOfABlockedStore && !isOfARowLeftAlone };
    },
  });
  report.counts.history.expected += plan.skippedHistoryCount;
  report.counts.history.notConverted += plan.skippedHistoryCount;
}

/** The whole write phase is one transaction, each entity family a savepoint inside it: any failure undoes the run. */
export function writePlan(db: DatabaseSync, plan: ImportPlan, report: ImportReport, beforeCommit: (managerOutcomes: Map<string, UpsertOutcome>) => void): void {
  inTransaction(db, 'importScape', () => {
    inTransaction(db, 'importScapeProjects', () => writeProjects(db, plan, report));
    inTransaction(db, 'importScapeNotes', () => writeNotes(db, plan, report));
    const blockedStores = inTransaction(db, 'importScapeDataStores', () => writeDataStoreDefinitions(db, plan, report));
    const rowOutcomes = inTransaction(db, 'importScapeRows', () => writeRows(db, plan, report, blockedStores));
    inTransaction(db, 'importScapeHistory', () => writeHistory(db, plan, report, { blockedStores, rowOutcomes }));
    const managerOutcomes = inTransaction(db, 'importScapeManagers', () => writeManagers(db, plan, report));
    beforeCommit(managerOutcomes);
  });
}
