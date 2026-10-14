import { MANAGER_ROLE, type DeniedCommand, type Session } from '@openfleet/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { descendantSessionIdsOf } from '../managers/lineage.js';
import type { ManagerDenials } from '../policy/managerDenials.js';
import { maskedSecrets } from '../redact.js';
import type { SessionService } from '../sessions/sessionService.js';
import { ok, refuse, truncateToByteBudget } from './toolResults.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_DENIED_COMMANDS_RESULT_BYTES = 1024 * 1024;

const isIsoDate = (text: string) => !Number.isNaN(Date.parse(text));

export interface DeniedCommandToolsDeps {
  managerDenials: ManagerDenials;
  sessions: Pick<SessionService, 'list'>;
  caller: Session;
}

export function registerDeniedCommandTools(server: McpServer, { managerDenials, sessions, caller }: DeniedCommandToolsDeps): void {
  const nameOfSession = (sessionId: string, allSessions: Session[]) => maskedSecrets(allSessions.find((session) => session.id === sessionId)?.name ?? sessionId);
  const entryOf = (denial: DeniedCommand, allSessions: Session[]) => ({
    kind: 'denied_command' as const,
    id: denial.id,
    at: denial.createdAt,
    session_id: denial.sessionId,
    session_name: nameOfSession(denial.sessionId, allSessions),
    rule_id: denial.ruleId,
    decision: denial.outcome,
    excerpt: denial.commandExcerpt,
    ...(denial.alternative === undefined ? {} : { alternative: denial.alternative }),
  });

  server.registerTool('list_denied_commands', {
    description: `Commands the policy refused (decision denied) or only watched (decision observed) in your lineage, newest first. Reading the whole list, with neither session_id nor since, resets your unseen-refusals counter. limit 1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}; since is an ISO date; session_id narrows to one session of your lineage. Commands are shown with secrets masked.`,
    inputSchema: { limit: z.number().int().min(1).max(MAX_LIMIT).optional(), since: z.string().optional(), session_id: z.string().optional() },
  }, async ({ limit = DEFAULT_LIMIT, since, session_id }) => {
    if (caller.role !== MANAGER_ROLE) return refuse('not_a_manager', 'only a manager can list the denied commands of its lineage');
    if (since !== undefined && !isIsoDate(since)) return refuse('invalid_body', 'since must be an ISO 8601 date');
    const allSessions = sessions.list();
    const lineageSessionIds = descendantSessionIdsOf(allSessions, caller.id);
    const isAskingForForeignSession = session_id !== undefined && !lineageSessionIds.includes(session_id);
    if (isAskingForForeignSession) return refuse('outside_lineage', 'session not found or outside your lineage');
    const isUnfilteredRead = session_id === undefined && since === undefined;
    const page = managerDenials.read({ managerId: caller.id, lineageSessionIds: session_id === undefined ? lineageSessionIds : [session_id], since, limit, marksAsSeen: isUnfilteredRead });
    const { items: denials, truncated } = truncateToByteBudget(page.denials.map((denial) => entryOf(denial, allSessions)), MAX_DENIED_COMMANDS_RESULT_BYTES);
    return ok({ denials, truncated: truncated || page.notShownCount > 0, ...(page.notShownCount > 0 && { not_shown: page.notShownCount }) });
  });
}
