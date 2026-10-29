import { ColumnConfigSchema, DisplayWidthSchema, OptionColorSchema, WrapMaxLinesSchema } from '@openfleet/shared';
import type { ScapeColumnMetadata } from './scapeSource.js';

/** The standard CSS color names (CSS 2.1), the only names converted to hex. */
const HEX_BY_CSS_COLOR_NAME: ReadonlyMap<string, string> = new Map(Object.entries({
  black: '#000000', silver: '#c0c0c0', gray: '#808080', grey: '#808080', white: '#ffffff', maroon: '#800000', red: '#ff0000',
  purple: '#800080', fuchsia: '#ff00ff', green: '#008000', lime: '#00ff00', olive: '#808000', yellow: '#ffff00',
  navy: '#000080', blue: '#0000ff', teal: '#008080', aqua: '#00ffff', orange: '#ffa500',
}));

/** The hex form of an option color: a hex color as it is, a standard CSS color name as its hex, anything else undefined. */
export function hexOfOptionColor(color: string): string | undefined {
  const isHex = OptionColorSchema.safeParse(color).success;
  if (isHex) return color;
  return HEX_BY_CSS_COLOR_NAME.get(color.trim().toLowerCase());
}

export interface DroppedSetting { field: string; value: string }

/** The column settings OpenFleet stores, as ds_columns values. */
export interface ColumnSettings {
  required: 0 | 1;
  displayColumnId: string | null;
  configJson: string | null;
  displayWidth: number | null;
  wrapMode: 'wrap' | null;
  wrapMaxLines: number | null;
}

const isPresent = (value: unknown): value is string | number => value !== null && value !== undefined && value !== '';

function configJsonOf(input: { raw: string; columnType: string }): string | null | DroppedSetting {
  const dropped = { field: 'config', value: input.raw };
  const isNumberColumn = input.columnType === 'number';
  if (!isNumberColumn) return dropped;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(input.raw);
  } catch {
    return dropped;
  }
  const config = ColumnConfigSchema.safeParse(parsedJson);
  if (!config.success) return dropped;
  const isEmptyConfig = Object.keys(config.data).length === 0;
  return isEmptyConfig ? null : JSON.stringify(config.data);
}

const isDropped = (result: unknown): result is DroppedSetting => typeof result === 'object' && result !== null;

/** The settings a Scape column holds that OpenFleet can keep, and the source values it cannot. The display column is kept as the source gives it: the store resolves it. */
export function settingsOfScapeColumn(column: ScapeColumnMetadata & { columnType: string }): { settings: ColumnSettings; dropped: DroppedSetting[] } {
  const dropped: DroppedSetting[] = [];
  const settings: ColumnSettings = { required: column.required === 1 ? 1 : 0, displayColumnId: null, configJson: null, displayWidth: null, wrapMode: null, wrapMaxLines: null };

  const isKnownRequiredFlag = !isPresent(column.required) || column.required === 0 || column.required === 1;
  if (!isKnownRequiredFlag) dropped.push({ field: 'required', value: String(column.required) });

  if (isPresent(column.displayColumnID)) settings.displayColumnId = String(column.displayColumnID);

  if (isPresent(column.config)) {
    const config = configJsonOf({ raw: String(column.config), columnType: column.columnType });
    if (isDropped(config)) dropped.push(config);
    else settings.configJson = config;
  }

  if (isPresent(column.displayWidth)) {
    const isValidWidth = DisplayWidthSchema.safeParse(column.displayWidth).success;
    if (isValidWidth) settings.displayWidth = Number(column.displayWidth);
    else dropped.push({ field: 'displayWidth', value: String(column.displayWidth) });
  }

  const wrapsCells = column.wrapMode === 'wrap';
  const isKnownWrapMode = wrapsCells || !isPresent(column.wrapMode) || column.wrapMode === 'truncate';
  if (wrapsCells) settings.wrapMode = 'wrap';
  if (!isKnownWrapMode) dropped.push({ field: 'wrapMode', value: String(column.wrapMode) });

  if (isPresent(column.wrapMaxLines)) {
    const isValidLineCap = wrapsCells && WrapMaxLinesSchema.safeParse(column.wrapMaxLines).success;
    if (isValidLineCap) settings.wrapMaxLines = Number(column.wrapMaxLines);
    else dropped.push({ field: 'wrapMaxLines', value: String(column.wrapMaxLines) });
  }
  return { settings, dropped };
}

interface ColumnWithDisplayColumn { id: string; settings: ColumnSettings }

/** Drops the display columns that are the column itself, outside the store or close a cycle, in column order, and lists them. */
export function withValidDisplayColumns<T extends ColumnWithDisplayColumn>(columns: T[]): { columns: T[]; dropped: { columnId: string; setting: DroppedSetting }[] } {
  const storeColumnIds = new Set(columns.map((column) => column.id));
  const keptDisplayColumnOf = new Map<string, string>();
  const dropped: { columnId: string; setting: DroppedSetting }[] = [];
  const resolved = columns.map((column) => {
    const target = column.settings.displayColumnId;
    if (target === null) return column;
    const isInStore = storeColumnIds.has(target) && target !== column.id;
    if (isInStore && !leadsBackTo({ from: target, to: column.id, via: keptDisplayColumnOf })) {
      keptDisplayColumnOf.set(column.id, target);
      return column;
    }
    dropped.push({ columnId: column.id, setting: { field: 'displayColumnID', value: target } });
    return { ...column, settings: { ...column.settings, displayColumnId: null } };
  });
  return { columns: resolved, dropped };
}

function leadsBackTo(input: { from: string; to: string; via: Map<string, string> }): boolean {
  let cursor: string | undefined = input.from;
  while (cursor !== undefined) {
    if (cursor === input.to) return true;
    cursor = input.via.get(cursor);
  }
  return false;
}
