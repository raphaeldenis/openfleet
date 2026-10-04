import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { columnsByCellKey, mapChange, mapColumn, mapNote, mapRow, mapVersions, mapView, type MappedColumn, type SelectedOption } from './scapeMappers.js';
import type { RecordValues } from './scapeTarget.js';
import { ScapeImportError } from './scapeImportError.js';
import { planManagers, type PlannedManager } from './scapeManagers.js';
import type { ScapeProject, ScapeSource } from './scapeSource.js';
import { scapeNotesDateToIso } from './scapeTime.js';
import { planPlaybookArchive, type PlannedPlaybookArchive } from './playbookArchive.js';
import { planWorkingStates, type PlannedWorkingState } from './scapeWorkingStates.js';
import { emptySourceLosses, type SourceLosses } from './importReport.js';

export interface PlannedRecord<Extra = object> { id: string; record: RecordValues; extra: Extra }

/** Everything a run intends to write, computed from the Scape sources before any write. */
export interface ImportPlan {
  sourceLosses: SourceLosses;
  playbookArchives: PlannedPlaybookArchive[];
  projects: PlannedRecord<{ projectName: string; hasDocsFolder: boolean }>[];
  notes: PlannedRecord<{ unconvertedTypes: string[]; currentVersionId: string }>[];
  noteVersions: PlannedRecord<{ unconvertedTypes: string[] }>[];
  dataStores: PlannedRecord[];
  columns: PlannedRecord<{ hasDroppedFormat: boolean }>[];
  views: PlannedRecord<{ hasDroppedFields: boolean }>[];
  skippedViewCount: number;
  rows: PlannedRecord<{ hasStaleSelectValue: boolean; selectedOptions: SelectedOption[] }>[];
  history: PlannedRecord[];
  skippedHistoryCount: number;
  managers: PlannedManager[];
  skippedManagerCount: number;
  workingStates: PlannedWorkingState[];
}

export interface PlanOptions { projectName: string | undefined; superpowersRoot: string; managersRoot: string; stateDir: string | undefined; stateRoot: string | undefined }

const directoryNamesIn = (root: string): string[] =>
  existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];

/** The existing docs folder for a project: the on-disk name equal to the project name, else equal ignoring case. Nothing is ever created. */
export function resolveDocsFolder(input: { superpowersRoot: string; projectName: string }): string | undefined {
  const names = directoryNamesIn(input.superpowersRoot);
  const exactName = names.find((name) => name === input.projectName);
  const folderName = exactName ?? names.find((name) => name.toLowerCase() === input.projectName.toLowerCase());
  return folderName === undefined ? undefined : join(input.superpowersRoot, folderName);
}

function selectProjects(source: ScapeSource, projectName: string | undefined): ScapeProject[] {
  const allProjects = source.projects();
  if (projectName === undefined) return allProjects;
  const selected = allProjects.filter((project) => project.name.toLowerCase() === projectName.toLowerCase());
  if (selected.length === 0) throw new ScapeImportError({ code: 'UNKNOWN_PROJECT', message: `no Scape project named "${projectName}"` });
  return selected;
}

const emptyPlan = (): ImportPlan => ({ sourceLosses: emptySourceLosses(), playbookArchives: [], projects: [], notes: [], noteVersions: [], dataStores: [], columns: [], views: [], skippedViewCount: 0, rows: [], history: [], skippedHistoryCount: 0, managers: [], skippedManagerCount: 0, workingStates: [] });

function planNotes(plan: ImportPlan, source: ScapeSource, project: ScapeProject): void {
  for (const note of source.notesOf(project.id)) {
    const versions = mapVersions(source.versionsOf(note.id));
    const mapped = mapNote(note, versions.length);
    plan.notes.push({ id: note.id, record: mapped.record, extra: { unconvertedTypes: mapped.unconvertedTypes, currentVersionId: mapped.currentVersion.id } });
    for (const version of versions) {
      plan.noteVersions.push({ id: version.id, record: version.record, extra: { unconvertedTypes: version.unconvertedTypes } });
    }
    plan.noteVersions.push({ id: mapped.currentVersion.id, record: mapped.currentVersion.record, extra: { unconvertedTypes: mapped.unconvertedTypes } });
  }
}

function planStoreColumns(plan: ImportPlan, source: ScapeSource, store: { id: string; createdAt: string }): MappedColumn[] {
  const columns = source.columnsOf(store.id).map(mapColumn);
  for (const column of columns) {
    const record = {
      store_id: column.storeId,
      display_name: column.displayName,
      column_type: column.columnType,
      options_json: column.options === null ? null : JSON.stringify(column.options),
      sort_order: column.sortOrder,
      created_at: store.createdAt,
    };
    const hasDroppedFormat = column.droppedFormat !== null;
    if (column.droppedFormat !== null) plan.sourceLosses.droppedColumnFormats.push({ columnId: column.id, format: column.droppedFormat });
    plan.columns.push({ id: column.id, record, extra: { hasDroppedFormat } });
  }
  return columns;
}

function planStores(plan: ImportPlan, source: ScapeSource, project: ScapeProject): void {
  for (const store of source.storesOf(project.id)) {
    if (!source.hasStoreTable(store)) plan.sourceLosses.storesWithoutTables.push(store.id);
    const createdAt = scapeNotesDateToIso(store.createdAt);
    plan.dataStores.push({
      id: store.id,
      record: { project_id: project.id, display_name: store.displayName, created_at: createdAt, updated_at: scapeNotesDateToIso(store.updatedAt) },
      extra: {},
    });
    const columns = planStoreColumns(plan, source, { id: store.id, createdAt });
    const cellColumns = columnsByCellKey(columns);

    for (const view of source.viewsOf(store.id)) {
      const mapped = mapView(view, columns);
      if (mapped === undefined) { plan.skippedViewCount++; continue; }
      if (mapped.hasDroppedFields) plan.sourceLosses.droppedViewFields.push({ viewId: view.id, fields: mapped.droppedFields });
      plan.views.push({ id: view.id, record: mapped.record, extra: { hasDroppedFields: mapped.hasDroppedFields } });
    }
    for (const row of source.rowsOf(store)) {
      const mapped = mapRow(row, cellColumns);
      plan.rows.push({ id: row.id, record: { store_id: store.id, ...mapped.record }, extra: { hasStaleSelectValue: mapped.hasStaleSelectValue, selectedOptions: mapped.selectedOptions } });
    }
    for (const change of source.changesOf(store)) {
      const mapped = mapChange(change, cellColumns);
      if (mapped === undefined) { plan.skippedHistoryCount++; continue; }
      plan.history.push({ id: mapped.id, record: mapped.record, extra: {} });
    }
  }
}

export function buildImportPlan(source: ScapeSource, options: PlanOptions): ImportPlan {
  const plan = emptyPlan();
  plan.sourceLosses.orphanDatastoreFiles = source.orphanDatastoreFiles();
  for (const project of selectProjects(source, options.projectName)) {
    const docsFolder = resolveDocsFolder({ superpowersRoot: options.superpowersRoot, projectName: project.name });
    plan.projects.push({
      id: project.id,
      record: { name: project.name, docs_folder_path: docsFolder ?? null, created_at: scapeNotesDateToIso(project.createdAt) },
      extra: { projectName: project.name, hasDocsFolder: docsFolder !== undefined },
    });
    planNotes(plan, source, project);
    const archive = planPlaybookArchive({ project, playbooks: source.playbooksOf(project.id), secretNames: source.playbookSecretNames() });
    if (archive !== undefined) plan.playbookArchives.push(archive);
    planStores(plan, source, project);
  }
  const availableResources = { noteIds: new Set(plan.notes.map((note) => note.id)), tableIds: new Set(plan.dataStores.map((store) => store.id)) };
  const managersPlan = planManagers({ arguses: source.arguses(), notes: plan.notes, availableResources, managersRoot: options.managersRoot });
  plan.managers = managersPlan.managers;
  plan.skippedManagerCount = managersPlan.skippedCount;
  plan.workingStates = planWorkingStates({ stateDir: options.stateDir, stateRoot: options.stateRoot, managers: plan.managers });
  return plan;
}
