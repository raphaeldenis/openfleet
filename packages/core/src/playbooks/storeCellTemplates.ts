import type { PlaybookCell } from '@openfleet/shared';
import { KernelError } from './kernel/kernelError.js';
import { assertTemplateAllowed, resolveTemplate, type ResolutionScope, type TemplateSlot, type UntrustedSources } from './kernel/tokenResolver.js';

type ReadCell = Extract<PlaybookCell, { kind: 'readFromStore' }>;
type WriteCell = Extract<PlaybookCell, { kind: 'writeToStore' }>;

export const READ_ROW_CAP = 1000;
export const DEFAULT_READ_ROWS = 100;

export type ResolvedStoreRead = {
  storeId: string;
  columnIds: string[] | undefined;
  where: { columnId: string; op: 'eq'; value: string }[];
  orderBy: { columnId: string; dir: 'asc' | 'desc' }[];
  limit: number;
};
export type ResolvedStoreWrite = { storeId: string; cells: Record<string, string>; naturalKeyColumnId: string | undefined };

type Resolvers = { identifier: (template: string) => string; value: (template: string) => string };

/**
 * The identifiers of a table and of its columns refuse the output of a step: only the literals and the inputs of the run can name where a cell reads or writes.
 * A value is data and accepts it. Every token is checked in its place again here, so a flow stored outside the save path is held to the same rules.
 */
const resolversOf = (scope: ResolutionScope, untrusted: UntrustedSources): Resolvers => {
  const resolveIn = (template: string, slot: TemplateSlot): string => {
    assertTemplateAllowed({ template, slot, untrusted });
    return resolveTemplate({ template, scope }).text;
  };
  return { identifier: (template) => resolveIn(template, 'store_identifier'), value: (template) => resolveIn(template, 'text') };
};

/** The table, columns, filter, order and row limit of a readFromStore cell with their tokens resolved. The limit never exceeds READ_ROW_CAP. Throws KernelError: store_filter_incomplete, or the refusals of the token rules. */
export function resolveStoreRead(cell: ReadCell, scope: ResolutionScope, untrusted: UntrustedSources): ResolvedStoreRead {
  const { identifier, value } = resolversOf(scope, untrusted);
  const hasFilterColumn = cell.whereColumnID !== undefined;
  const hasFilterValue = cell.whereValue !== undefined;
  const isFilterIncomplete = hasFilterColumn !== hasFilterValue;
  if (isFilterIncomplete) throw new KernelError('store_filter_incomplete', 'whereColumnID and whereValue go together: a filter with only one of them would read every row.');

  return {
    storeId: identifier(cell.storeID),
    columnIds: cell.columns?.map(identifier),
    where: hasFilterColumn && hasFilterValue ? [{ columnId: identifier(cell.whereColumnID!), op: 'eq', value: value(cell.whereValue!) }] : [],
    orderBy: cell.sortColumnID === undefined ? [] : [{ columnId: identifier(cell.sortColumnID), dir: cell.sortDescending === true ? 'desc' : 'asc' }],
    limit: Math.min(cell.limit ?? DEFAULT_READ_ROWS, READ_ROW_CAP),
  };
}

/** The table and the cells of a writeToStore cell with their tokens resolved; a value that holds a secret is masked by the caller. */
export function resolveStoreWrite(cell: WriteCell, scope: ResolutionScope, untrusted: UntrustedSources): ResolvedStoreWrite {
  const { identifier, value } = resolversOf(scope, untrusted);
  const cells = Object.fromEntries(Object.entries(cell.rowMappings).map(([columnTemplate, valueTemplate]) => [identifier(columnTemplate), value(valueTemplate)]));
  return { storeId: identifier(cell.storeID), cells, naturalKeyColumnId: cell.naturalKeyColumnID === undefined ? undefined : identifier(cell.naturalKeyColumnID) };
}
