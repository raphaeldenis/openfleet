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

/** Query-string integers arrive as text; `limit` defaults to DEFAULT_PAGE_LIMIT and is refused (not clamped) above `maxLimit`. */
export const pageQuerySchema = (maxLimit: number) => z.object({
  limit: z.coerce.number().int().min(0).max(maxLimit).default(DEFAULT_PAGE_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});
