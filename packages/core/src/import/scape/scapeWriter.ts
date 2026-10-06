import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from '../../db/transaction.js';
import { countOutcome, type EntityName, type ImportReport } from './importReport.js';
import { ACTOR_LABEL_PREFIX, IMPORT_AUTHOR } from './scapeMappers.js';
import type { ImportPlan, PlannedRecord } from './scapePlan.js';
import { writeManagers } from './scapeManagersWriter.js';
import { writeMemories, type MemoryWriteContext } from './scapeMemoriesWriter.js';
import { writeWorkingStates } from './scapeWorkingStatesWriter.js';
import { ImportLedger, type LedgerKind } from './scapeLedger.js';
import { reportRemovedInScape } from './scapeRemovals.js';
import { isLeftAlone, upsertRecord, type UpsertOutcome, type WritePolicy } from './scapeTarget.js';
import { writePlaybookArchives } from './playbookArchive.js';

interface FamilyInput<Extra> {
  db: DatabaseSync;
  ledger: ImportLedger;
  entity: EntityName;
  kind: LedgerKind;
  table: string;
  planned: PlannedRecord<Extra>[];
  report: ImportReport;
  policyOf?: (planned: PlannedRecord<Extra>) => WritePolicy;
  isNotConverted?: (extra: Extra) => boolean;
}

function writeEntities<Extra>(input: FamilyInput<Extra>): Map<string, UpsertOutcome> {
  const counts = input.report.counts[input.entity];
  const outcomes = new Map<string, UpsertOutcome>();
  for (const planned of input.planned) {
    counts.expected++;
    const outcome = upsertRecord(input.db, { table: input.table, kind: input.kind, id: planned.id, record: planned.record, policy: input.policyOf?.(planned), ledger: input.ledger });
    outcomes.set(planned.id, outcome);
    countOutcome(counts, outcome);
    if (input.isNotConverted?.(planned.extra)) counts.notConverted++;
  }
  return outcomes;
}

const hasUnconvertedTypes = (extra: { unconvertedTypes: string[] }) => extra.unconvertedTypes.length > 0;

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

const isStored = (db: DatabaseSync, table: string, id: string) => db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;

/** The docs folder of a project is OpenFleet's to set: the stored one is kept and takes no part in the compare. */
function writeProjects(input: { db: DatabaseSync; ledger: ImportLedger; plan: ImportPlan; report: ImportReport }): void {
  const { db, plan } = input;
  const keepingAnExistingDocsFolder = plan.projects.map((project) => {
    const stored = db.prepare('SELECT docs_folder_path FROM projects WHERE id = ?').get(project.id) as { docs_folder_path: string | null } | undefined;
    const docsFolderPath = stored?.docs_folder_path ?? project.record.docs_folder_path ?? null;
    return { ...project, record: { ...project.record, docs_folder_path: docsFolderPath } };
  });
  writeEntities({ ...input, entity: 'projects', kind: 'project', table: 'projects', planned: keepingAnExistingDocsFolder, policyOf: () => ({ ignoredColumns: ['docs_folder_path'] }) });
  input.report.projectsWithoutDocsFolder = keepingAnExistingDocsFolder.filter((project) => project.record.docs_folder_path === null).map((project) => project.extra.projectName);
}

function removeStaleCurrentVersions(input: { db: DatabaseSync; ledger: ImportLedger; note: PlannedRecord<{ currentVersionId: string }> }): void {
  const { db, ledger, note } = input;
  const staleVersionIds = (db
    .prepare(`SELECT id FROM note_versions WHERE note_id = ? AND author = ? AND id LIKE ? AND id <> ?`)
    .all(note.id, IMPORT_AUTHOR, `${note.id}@rev%`, note.extra.currentVersionId) as { id: string }[]).map((version) => version.id);
  for (const versionId of staleVersionIds) {
    db.prepare('DELETE FROM note_versions WHERE id = ?').run(versionId);
    ledger.forget('note_version', versionId);
  }
}

function writeNotes(input: { db: DatabaseSync; ledger: ImportLedger; plan: ImportPlan; report: ImportReport }): void {
  const { db, ledger, plan, report } = input;
  const noteOutcomes = writeEntities({
    db, ledger, report, entity: 'notes', kind: 'note', table: 'notes', planned: plan.notes, isNotConverted: hasUnconvertedTypes,
    policyOf: (note) => ({ canUpdate: () => !hasOpenFleetSideVersion(db, note.id) }),
  });
  plan.notes.filter((note) => noteOutcomes.get(note.id) === 'updated').forEach((note) => removeStaleCurrentVersions({ db, ledger, note }));

  const versionsOfNotesLeftAlone = plan.noteVersions.filter((version) => noteOutcomes.get(String(version.record.note_id)) === 'conflict');
  const versionsToWrite = plan.noteVersions.filter((version) => !versionsOfNotesLeftAlone.includes(version));
  const versionCounts = report.counts.noteVersions;
  versionCounts.expected += versionsOfNotesLeftAlone.length;
  versionCounts.conflict += versionsOfNotesLeftAlone.length;
  writeEntities({
    db, ledger, report, entity: 'noteVersions', kind: 'note_version', table: 'note_versions', planned: versionsToWrite, isNotConverted: hasUnconvertedTypes,
    policyOf: (version) => ({ canInsert: () => isStored(db, 'notes', String(version.record.note_id)) }),
  });
  for (const note of plan.notes) {
    for (const type of note.extra.unconvertedTypes) report.unconvertedNodeTypes[type] = (report.unconvertedNodeTypes[type] ?? 0) + 1;
  }
}

/** The stores whose own record or one of whose columns is missing from OpenFleet: nothing may hang on them. */
function storesBlockedByAMissingDefinition(db: DatabaseSync, plan: ImportPlan): Set<string> {
  const missingStores = plan.dataStores.filter((store) => !isStored(db, 'data_stores', store.id)).map((store) => store.id);
  const storesMissingAColumn = plan.columns.filter((column) => !isStored(db, 'ds_columns', column.id)).map((column) => String(column.record.store_id));
  return new Set([...missingStores, ...storesMissingAColumn]);
}

const DATA_STORE_WRITE_POLICY: WritePolicy = { ignoredColumns: ['updated_at'], columnsOmittedFromHashWhenNull: ['natural_key_column_id'] };

function writeDataStoreDefinitions(input: { db: DatabaseSync; ledger: ImportLedger; plan: ImportPlan; report: ImportReport }): Set<string> {
  const { db, plan, report } = input;
  writeEntities({ ...input, entity: 'dataStores', kind: 'data_store', table: 'data_stores', planned: plan.dataStores, policyOf: () => DATA_STORE_WRITE_POLICY });
  const storesWithoutRecord = new Set(plan.dataStores.filter((store) => !isStored(db, 'data_stores', store.id)).map((store) => store.id));
  const onlyWhereTheStoreExists = (planned: PlannedRecord): WritePolicy => ({ canInsert: () => !storesWithoutRecord.has(String(planned.record.store_id)) });
  writeEntities({
    ...input, entity: 'columns', kind: 'column', table: 'ds_columns', planned: plan.columns,
    policyOf: (column) => ({ ...onlyWhereTheStoreExists(column), columnsOmittedFromHashWhenNull: ['column_format'] }),
    isNotConverted: (extra) => extra.hasDroppedFormat,
  });
  writeEntities({ ...input, entity: 'views', kind: 'view', table: 'ds_views', planned: plan.views, policyOf: onlyWhereTheStoreExists, isNotConverted: (extra) => extra.hasDroppedFields });
  report.counts.views.expected += plan.skippedViewCount;
  report.counts.views.notConverted += plan.skippedViewCount;
  return storesBlockedByAMissingDefinition(db, plan);
}

/** The option ids each select column holds in OpenFleet now, after the column definitions were written. */
function storedOptionIdsByColumn(db: DatabaseSync): Map<string, Set<string>> {
  const columns = db.prepare(`SELECT id, options_json FROM ds_columns WHERE column_type = 'select'`).all() as { id: string; options_json: string | null }[];
  return new Map(columns.map((column) => [column.id, new Set((JSON.parse(column.options_json ?? '[]') as { id: string }[]).map((option) => option.id))]));
}

function writeRows(input: { db: DatabaseSync; ledger: ImportLedger; plan: ImportPlan; report: ImportReport; blockedStores: Set<string> }): Map<string, UpsertOutcome> {
  const { db, blockedStores } = input;
  const storedOptionIds = storedOptionIdsByColumn(db);
  return writeEntities({
    ...input, entity: 'rows', kind: 'row', table: 'ds_rows', planned: input.plan.rows, isNotConverted: (extra) => extra.hasStaleSelectValue,
    policyOf: (row) => {
      const isBlocked = blockedStores.has(String(row.record.store_id));
      const usesAnOptionTheStoredColumnLacks = row.extra.selectedOptions.some(({ columnId, optionId }) => !storedOptionIds.get(columnId)?.has(optionId));
      return {
        canInsert: () => !isBlocked && !usesAnOptionTheStoredColumnLacks && !hasRowDeletedInOpenFleet(db, row.id),
        canUpdate: () => !isBlocked && !usesAnOptionTheStoredColumnLacks && !hasHistoryFromOpenFleet(db, row.id),
      };
    },
  });
}

function writeHistory(input: { db: DatabaseSync; ledger: ImportLedger; plan: ImportPlan; report: ImportReport; blockedStores: Set<string>; rowOutcomes: Map<string, UpsertOutcome> }): void {
  const { plan, report } = input;
  writeEntities({
    ...input, entity: 'history', kind: 'history', table: 'ds_row_history', planned: plan.history,
    policyOf: (entry) => {
      const isOfABlockedStore = input.blockedStores.has(String(entry.record.store_id));
      const isOfARowLeftAlone = isLeftAlone(input.rowOutcomes.get(String(entry.record.row_id)));
      return { canInsert: () => !isOfABlockedStore && !isOfARowLeftAlone };
    },
  });
  report.counts.history.expected += plan.skippedHistoryCount;
  report.counts.history.notConverted += plan.skippedHistoryCount;
}

export interface WritePlanOptions {
  /** True when the plan covers every Scape project: only then does a record missing from the plan mean it was removed in Scape. */
  coversEveryProject: boolean;
  /** Absent when the run does not cover the Claude memory. */
  memories?: MemoryWriteContext;
}

/** The whole write phase, ledger included, is one transaction, each entity family a savepoint inside it: any failure undoes the run. */
export function writePlan(db: DatabaseSync, plan: ImportPlan, report: ImportReport, options: WritePlanOptions, beforeCommit: (managerOutcomes: Map<string, UpsertOutcome>) => void): void {
  const ledger = new ImportLedger(db);
  inTransaction(db, 'importScape', () => {
    inTransaction(db, 'importScapeProjects', () => writeProjects({ db, ledger, plan, report }));
    inTransaction(db, 'importScapeNotes', () => writeNotes({ db, ledger, plan, report }));
    inTransaction(db, 'importScapePlaybooks', () => writePlaybookArchives({ db, ledger, archives: plan.playbookArchives, report }));
    const blockedStores = inTransaction(db, 'importScapeDataStores', () => writeDataStoreDefinitions({ db, ledger, plan, report }));
    const rowOutcomes = inTransaction(db, 'importScapeRows', () => writeRows({ db, ledger, plan, report, blockedStores }));
    inTransaction(db, 'importScapeHistory', () => writeHistory({ db, ledger, plan, report, blockedStores, rowOutcomes }));
    const managerOutcomes = inTransaction(db, 'importScapeManagers', () => writeManagers(db, plan, report));
    inTransaction(db, 'importScapeWorkingStates', () => writeWorkingStates(db, plan, report, managerOutcomes));
    if (options.memories !== undefined) {
      const context = options.memories;
      inTransaction(db, 'importScapeMemories', () => writeMemories({ db, plan, report, managerOutcomes, context }));
    }
    if (options.coversEveryProject) reportRemovedInScape({ ledger, plan, report });
    beforeCommit(managerOutcomes);
  });
}
