import { z } from 'zod';

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_NOTE_PAGE_LIMIT = 200;
export const MAX_ROW_PAGE_LIMIT = 1000;

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** A query-string integer: digits only, so an empty or blank value is refused instead of coercing to 0. */
export const queryInteger = z.string().regex(/^\d+$/, 'must be a non-negative integer').transform(Number);

/** Query-string integers arrive as text; `limit` defaults to DEFAULT_PAGE_LIMIT and is refused (not clamped) above `maxLimit`. */
export const pageQuerySchema = (maxLimit: number) => z.object({
  limit: queryInteger.pipe(z.number().max(maxLimit)).default(DEFAULT_PAGE_LIMIT),
  offset: queryInteger.default(0),
});
