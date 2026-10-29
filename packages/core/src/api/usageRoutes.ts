import * as z from 'zod';
import type { UsageLedgerService } from '../usage/usageLedgerService.js';
import { json, queryParams, type Router } from './router.js';

const UTC_DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const DailyQuerySchema = z.object({
  from: UTC_DAY.optional(),
  to: UTC_DAY.optional(),
  sessionId: z.string().min(1).optional(),
  billingCode: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

/** Reads the usage ledger; every route sits under /api behind the admin token, and nothing here writes. */
export function registerUsageRoutes(router: Router, deps: { usageLedger: Pick<UsageLedgerService, 'dailyUsage'> }): void {
  router.add('GET', '/api/usage/daily', ({ req, res }) => {
    const { from, to, sessionId, billingCode, model } = DailyQuerySchema.parse(queryParams(req));
    const filter = {
      ...(from === undefined ? {} : { fromDayUtc: from }),
      ...(to === undefined ? {} : { toDayUtc: to }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(billingCode === undefined ? {} : { billingCode }),
      ...(model === undefined ? {} : { model }),
    };
    json(res, 200, { items: deps.usageLedger.dailyUsage(filter) });
  });
}
