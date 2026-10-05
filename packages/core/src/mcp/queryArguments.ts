import { WHERE_OPERATORS, type DsColumn, type OrderTerm, type WhereClause } from '@openfleet/shared';
import { z } from 'zod';
import { InvalidQueryError } from '../stores/dataStoreService.js';
import { coerceFilterValue, requireColumn } from './rowValues.js';

const NOT_EQUAL_ALIAS = 'ne';

/** A column is named by `column` (an id or a display name in any case); `columnId` stays accepted. */
const columnReferenceFields = { column: z.string().min(1).optional(), columnId: z.string().min(1).optional() };

export const QueryWhereClauseSchema = z.object({ ...columnReferenceFields, op: z.enum([...WHERE_OPERATORS, NOT_EQUAL_ALIAS]), value: z.unknown() });
export const QueryOrderTermSchema = z.object({ ...columnReferenceFields, dir: z.enum(['asc', 'desc']) });
export type QueryWhereClause = z.infer<typeof QueryWhereClauseSchema>;
export type QueryOrderTerm = z.infer<typeof QueryOrderTermSchema>;

function columnOf(columns: DsColumn[], term: { column?: string | undefined; columnId?: string | undefined }): DsColumn {
  const reference = term.column ?? term.columnId;
  if (reference === undefined) throw new InvalidQueryError('Name the column of each where clause and order_by term with column');
  return requireColumn(columns, reference);
}

function filterValueOf(column: DsColumn, clause: QueryWhereClause): unknown {
  if (clause.op === 'contains') return clause.value;
  if (clause.op !== 'in') return coerceFilterValue(column, clause.value);
  if (!Array.isArray(clause.value)) throw new InvalidQueryError('The value of an "in" clause is a list of values');
  return clause.value.map((candidate: unknown) => coerceFilterValue(column, candidate));
}

/** The where clauses keyed by column id, with names resolved, `ne` read as `neq` and values coerced to their column. */
export function whereClausesOf(columns: DsColumn[], clauses: QueryWhereClause[]): WhereClause[] {
  return clauses.map((clause) => {
    const column = columnOf(columns, clause);
    const op = clause.op === NOT_EQUAL_ALIAS ? 'neq' : clause.op;
    return { columnId: column.id, op, value: filterValueOf(column, clause) };
  });
}

export function orderTermsOf(columns: DsColumn[], terms: QueryOrderTerm[]): OrderTerm[] {
  return terms.map((term) => ({ columnId: columnOf(columns, term).id, dir: term.dir }));
}
