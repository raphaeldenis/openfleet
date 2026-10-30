import { OpenFleetError } from '@openfleet/shared';
import * as z from 'zod';
import type { ProjectRepository } from '../projects/projectRepository.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { UsageDailyRow, UsageLedgerService } from '../usage/usageLedgerService.js';
import { json, queryParams, type Router } from './router.js';

const notFound = (what: string) => new OpenFleetError('not_found', `the ${what} does not exist.`);

const UTC_DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const DailyQuerySchema = z.object({
  from: UTC_DAY.optional(),
  to: UTC_DAY.optional(),
  sessionId: z.string().min(1).optional(),
  billingCode: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

const UTC_DAY_KEY_LENGTH = 'YYYY-MM-DD'.length;

interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
}

/** Null when the ledger holds no row at all: an absent count is not a zero count. */
const tokenCountsOf = (rows: UsageDailyRow[]): TokenCounts | null => {
  const hasNoUsage = rows.length === 0;
  if (hasNoUsage) return null;
  const inputTokens = rows.reduce((sum, row) => sum + row.inputTokens, 0);
  const outputTokens = rows.reduce((sum, row) => sum + row.outputTokens, 0);
  return { inputTokens, outputTokens };
};

export interface UsageRouteDeps {
  usageLedger: Pick<UsageLedgerService, 'dailyUsage'>;
  sessions: Pick<SessionService, 'get' | 'list'>;
  projects?: Pick<ProjectRepository, 'get'>;
}

/** Reads the usage ledger; every route sits under /api behind the admin token, and nothing here writes. */
export function registerUsageRoutes(router: Router, deps: UsageRouteDeps): void {
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

  router.add('GET', '/api/sessions/:id/usage', ({ res, params }) => {
    const sessionId = params.id!;
    if (!deps.sessions.get(sessionId)) throw notFound('session');
    json(res, 200, tokenCountsOf(deps.usageLedger.dailyUsage({ sessionId })));
  });

  const { projects } = deps;
  if (!projects) return;

  router.add('GET', '/api/projects/:id/usage/today', ({ res, params }) => {
    const projectId = params.id!;
    if (!projects.get(projectId)) throw notFound('project');
    const dayUtc = new Date().toISOString().slice(0, UTC_DAY_KEY_LENGTH);
    const projectSessionIds = new Set(deps.sessions.list().filter((session) => session.projectId === projectId).map((session) => session.id));
    const todayRowsOfProject = deps.usageLedger.dailyUsage({ fromDayUtc: dayUtc, toDayUtc: dayUtc }).filter((row) => projectSessionIds.has(row.sessionId));
    const tokenCounts = tokenCountsOf(todayRowsOfProject);
    json(res, 200, tokenCounts && { dayUtc, ...tokenCounts });
  });
}
