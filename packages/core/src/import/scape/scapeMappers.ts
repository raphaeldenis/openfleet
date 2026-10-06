import { convertLexicalToMarkdown } from '../lexicalToMarkdown.js';
import { COLUMN_TYPE_BY_FORMAT, ColumnFormatSchema, type ColumnFormat } from '@openfleet/shared';
import { ScapeImportError } from './scapeImportError.js';
import { cellKeyOf, type ScapeColumn, type ScapeNote, type ScapeNoteVersion, type ScapeRow, type ScapeRowChange, type ScapeView } from './scapeSource.js';
import { scapeNotesDateToIso, unixSecondsToIso } from './scapeTime.js';

export const IMPORT_AUTHOR = 'scape-import';
export const ACTOR_LABEL_PREFIX = 'scape-import:';
const EMPTY_LEXICAL_DOCUMENT = '{}';
const PLAN_NOTE_TITLE = /^Plan CCM-/;
const FORGE_REPORT_NOTE_TITLE = /^Forge report/;

type SelectOption = { id: string; label: string };
type OpenFleetColumnType = 'text' | 'number' | 'date' | 'select';
const NATIVE_FORMAT_BY_COLUMN_TYPE: Record<OpenFleetColumnType, string> = {
  text: 'singleLine', number: 'number', date: 'date', select: 'singleSelect',
};

export interface MappedColumn {
  id: string;
  storeId: string;
  displayName: string;
  columnType: OpenFleetColumnType;
  format: ColumnFormat | null;
  options: SelectOption[] | null;
  sortOrder: number;
  droppedFormat: string | null;
}

export type ColumnsByCellKey = Map<string, MappedColumn>;

/** A row value that is one of the options of its select column in Scape. */
export interface SelectedOption { columnId: string; optionId: string }

const unreadable = (message: string) => new ScapeImportError({ code: 'SCAPE_SOURCE_UNREADABLE', message });

function parseJson<T>(text: string, whatIsParsed: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new ScapeImportError({ code: 'SCAPE_SOURCE_UNREADABLE', message: `${whatIsParsed} is not valid JSON`, cause });
  }
}

const convertLexical = (content: string) => {
  try {
    const { markdown, unconvertedTypes } = convertLexicalToMarkdown(content);
    return { markdown, unconvertedTypes };
  } catch (cause) {
    throw new ScapeImportError({ code: 'SCAPE_SOURCE_UNREADABLE', message: `a lexical document cannot be read: ${(cause as Error).message}`, cause });
  }
};

const bodyMarkdownOf = (input: { content: string; contentFormat: string }): { markdown: string; unconvertedTypes: string[] } => {
  const looksLikeLexicalJson = input.content.trimStart().startsWith('{');
  const isLexical = input.contentFormat === 'lexical' && looksLikeLexicalJson;
  if (!isLexical) return { markdown: input.content, unconvertedTypes: [] };
  const isEmptyDocument = input.content.trim() === EMPTY_LEXICAL_DOCUMENT;
  if (isEmptyDocument) return { markdown: '', unconvertedTypes: [] };
  return convertLexical(input.content);
};

export const currentVersionIdOf = (noteId: string, rev: number) => `${noteId}@rev${rev}`;

const folderOf = (title: string): 'plans' | 'reports' | null => {
  if (PLAN_NOTE_TITLE.test(title)) return 'plans';
  if (FORGE_REPORT_NOTE_TITLE.test(title)) return 'reports';
  return null;
};

/** The note at rev n+1 (n Scape versions) and the version row holding its current body, as OpenFleet keeps one version per rev. */
export function mapNote(note: ScapeNote, versionCount: number) {
  const body = bodyMarkdownOf(note);
  const rev = versionCount + 1;
  const updatedAt = scapeNotesDateToIso(note.updatedAt);
  const record = {
    project_id: note.projectId,
    title: note.title,
    body_md: body.markdown,
    folder: folderOf(note.title),
    rev,
    shared: note.isShared ? 1 : 0,
    created_at: scapeNotesDateToIso(note.createdAt),
    updated_at: updatedAt,
  };
  const currentVersion = {
    id: currentVersionIdOf(note.id, rev),
    record: { note_id: note.id, rev, body_md: body.markdown, author: IMPORT_AUTHOR, change_summary: 'current', created_at: updatedAt },
  };
  return { record, currentVersion, unconvertedTypes: body.unconvertedTypes };
}

/** Versions ordered by creation date get the revs 1..n. */
export function mapVersions(versions: ScapeNoteVersion[]) {
  return versions.map((version, index) => {
    const body = bodyMarkdownOf(version);
    return {
      id: version.id,
      unconvertedTypes: body.unconvertedTypes,
      record: {
        note_id: version.noteId,
        rev: index + 1,
        body_md: body.markdown,
        author: IMPORT_AUTHOR,
        change_summary: version.source,
        created_at: scapeNotesDateToIso(version.createdAt),
      },
    };
  });
}

function parseSelectOptions(rawOptions: string | null): SelectOption[] | null {
  if (rawOptions === null) return null;
  const parsed = parseJson<{ id: string; label: string }[]>(rawOptions, 'a column options list');
  return parsed.length === 0 ? null : parsed.map(({ id, label }) => ({ id, label }));
}

export function mapColumn(column: ScapeColumn): MappedColumn {
  const options = parseSelectOptions(column.options);
  const isTextWithOptions = column.columnType === 'text' && options !== null;
  const isKnownType = ['text', 'number', 'date'].includes(column.columnType);
  if (!isKnownType) throw unreadable(`unsupported Scape column type "${column.columnType}" on column ${column.id}`);
  const columnType = isTextWithOptions ? 'select' : (column.columnType as OpenFleetColumnType);
  const parsedFormat = ColumnFormatSchema.safeParse(column.format);
  const isCompatibleFormat = parsedFormat.success && COLUMN_TYPE_BY_FORMAT[parsedFormat.data] === columnType;
  const format = isCompatibleFormat ? parsedFormat.data : null;
  const hasNativeFormat = column.format === NATIVE_FORMAT_BY_COLUMN_TYPE[columnType];
  const droppedFormat = hasNativeFormat || format !== null ? null : column.format || null;
  return { id: column.id, storeId: column.storeId, displayName: column.displayName, columnType, format, options: isTextWithOptions ? options : null, sortOrder: column.sortOrder, droppedFormat };
}

export const columnsByCellKey = (columns: MappedColumn[]): ColumnsByCellKey => new Map(columns.map((column) => [cellKeyOf(column.id), column]));

function mapCell(value: unknown, column: MappedColumn): unknown {
  if (value === null || value === undefined) return undefined;
  const isDate = column.columnType === 'date' && typeof value === 'number';
  return isDate ? unixSecondsToIso(value) : value;
}

const isStaleSelectValue = (value: unknown, column: MappedColumn) => column.columnType === 'select' && !column.options!.some((option) => option.id === value);

export function mapRow(row: ScapeRow, columns: ColumnsByCellKey) {
  const data: Record<string, unknown> = {};
  const selectedOptions: SelectedOption[] = [];
  let hasStaleSelectValue = false;
  for (const [key, column] of [...columns.entries()].sort(([, a], [, b]) => a.id.localeCompare(b.id))) {
    const cell = mapCell(row.cells[key], column);
    if (cell === undefined) continue;
    data[column.id] = cell;
    const isStale = isStaleSelectValue(cell, column);
    hasStaleSelectValue ||= isStale;
    if (column.columnType === 'select' && !isStale) selectedOptions.push({ columnId: column.id, optionId: String(cell) });
  }
  const record = { data_json: JSON.stringify(data), created_at: unixSecondsToIso(row.createdAt), updated_at: unixSecondsToIso(row.updatedAt) };
  return { record, hasStaleSelectValue, selectedOptions };
}

const parseValues = (json: string | null): Record<string, unknown> => (json === null ? {} : parseJson<Record<string, unknown>>(json, 'a row change log value'));

function updateDiffOf(change: ScapeRowChange, columns: ColumnsByCellKey): Record<string, { from: unknown; to: unknown }> {
  const oldValues = parseValues(change.oldValues);
  const newValues = parseValues(change.newValues);
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of new Set([...Object.keys(oldValues), ...Object.keys(newValues)])) {
    const column = columns.get(key);
    const from = column ? (mapCell(oldValues[key], column) ?? null) : (oldValues[key] ?? null);
    const to = column ? (mapCell(newValues[key], column) ?? null) : (newValues[key] ?? null);
    const hasChanged = JSON.stringify(from) !== JSON.stringify(to);
    if (hasChanged) diff[column?.id ?? key] = { from, to };
  }
  return diff;
}

/** Returns undefined for an update that changed no value: it has nothing to tell. */
export function mapChange(change: ScapeRowChange, columns: ColumnsByCellKey) {
  const changeBody = change.kind === 'insert' ? { kind: 'create' } : change.kind === 'delete' ? { kind: 'delete' } : updateDiffOf(change, columns);
  const isUpdateWithoutChange = Object.keys(changeBody).length === 0;
  if (isUpdateWithoutChange) return undefined;
  return {
    id: `${change.storeId}#${change.seq}`,
    record: {
      store_id: change.storeId,
      row_id: change.rowId,
      actor_kind: 'agent',
      actor_label: `${ACTOR_LABEL_PREFIX}${change.source}`,
      change_json: JSON.stringify(changeBody),
      created_at: unixSecondsToIso(change.createdAt),
    },
  };
}

/** Returns undefined for a kanban view whose group-by column is not a select column of the store: it cannot be rendered. */
export function mapView(view: ScapeView, columns: MappedColumn[]) {
  const scapeConfig = parseJson<Record<string, unknown>>(view.config, `the config of view ${view.id}`);
  const isKanban = view.viewType === 'kanban';
  const groupByColumnId = typeof scapeConfig.groupByColumnID === 'string' ? scapeConfig.groupByColumnID : undefined;
  const groupByColumn = columns.find((column) => column.id === groupByColumnId);
  if (isKanban && groupByColumn?.columnType !== 'select') return undefined;

  const config = isKanban ? { groupByColumnId } : {};
  const droppedFields = Object.keys(scapeConfig).filter((key) => !(isKanban && key === 'groupByColumnID'));
  const record = {
    store_id: view.storeId,
    display_name: view.name,
    view_type: isKanban ? 'kanban' : 'grid',
    config_json: JSON.stringify(config),
    sort_order: view.sortOrder,
    created_at: scapeNotesDateToIso(view.createdAt),
  };
  return { record, hasDroppedFields: droppedFields.length > 0, droppedFields };
}
