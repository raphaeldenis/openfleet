import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ShipVerdictSchema, type Session, type ShipVerdict } from '@openfleet/shared';
import { z } from 'zod';
import { run } from '../git/worktrees.js';
import { log } from '../logger.js';
import type { ManagerService } from '../managers/managerService.js';
import { maskedSecrets } from '../redact.js';
import type { ReviewFindingsRepository } from '../review/reviewFindingsRepository.js';
import type { SessionService } from '../sessions/sessionService.js';
import { ok, refuse } from './toolResults.js';

export const REVIEWER_ROLE = 'reviewer';

const TICKET_IN_BRANCH = /[A-Z][A-Z0-9]+-\d+/;
const SHORT_SHA_LENGTH = 8;
const MAX_VERDICT_MESSAGE_CHARS = 1500;
const GIT_TIMEOUT_MS = 10_000;

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const cappedAt = (text: string, maxChars: number) => (text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text);

const gitOutput = async (args: string[], directory: string): Promise<string | undefined> => {
  try {
    const { stdout } = await run(args, { cwd: directory, timeoutMs: GIT_TIMEOUT_MS });
    return stdout.trim();
  } catch {
    return undefined;
  }
};

const noGoMessageOf = ({ ticket, sha, reasons }: { ticket: string; sha: string; reasons: string[] }) =>
  cappedAt(maskedSecrets(oneLine(`[verdict] no-go ${ticket} @ ${sha.slice(0, SHORT_SHA_LENGTH)}: ${reasons.join('; ')}`)), MAX_VERDICT_MESSAGE_CHARS);

export interface RegisterShipVerdictToolsDeps {
  reviewFindings: ReviewFindingsRepository;
  managers: Pick<ManagerService, 'get'>;
  sessions: Pick<SessionService, 'sendMessage'>;
  caller: Session;
  clock?: () => string;
}

export function registerShipVerdictTools(server: McpServer, deps: RegisterShipVerdictToolsDeps): void {
  const { reviewFindings, managers, sessions, caller, clock = () => new Date().toISOString() } = deps;

  server.registerTool('report_ship_verdict', {
    description: 'Report your delivery verdict on the ticket of your worktree (reviewers only). verdict is "go" or "no-go"; a no-go names one to five reasons (300 characters each); sha is the 40-character commit you reviewed and must be the head of your worktree. The daemon records the line itself and tells your manager about a no-go. Answers recorded and the gate: open after a go, blocked after a no-go',
    inputSchema: { verdict: z.string(), reasons: z.array(z.string()), sha: z.string() },
  }, async (input) => {
    const manager = caller.parentId ? managers.get(caller.parentId) : undefined;
    const isReviewerOfAManager = caller.role === REVIEWER_ROLE && manager !== undefined;
    if (!isReviewerOfAManager) return refuse('not_a_manager', 'only a reviewer spawned by a manager can report a ship verdict');

    const parsedVerdict = ShipVerdictSchema.safeParse(input);
    if (!parsedVerdict.success) return refuse('invalid_body', parsedVerdict.error.issues.map((issue) => issue.message).join('; '));
    const shipVerdict: ShipVerdict = parsedVerdict.data;

    const branch = await gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], caller.directory);
    const ticket = branch?.match(TICKET_IN_BRANCH)?.[0];
    if (!ticket) return refuse('invalid_body', 'the branch of your worktree names no ticket', 'Name the branch with the ticket, such as CCM-123-short-title.');

    const head = await gitOutput(['rev-parse', 'HEAD'], caller.directory);
    if (shipVerdict.sha !== head) return refuse('verdict_stale', `the verdict is for ${shipVerdict.sha.slice(0, SHORT_SHA_LENGTH)} but the head of your worktree is ${head?.slice(0, SHORT_SHA_LENGTH) ?? 'unknown'}`, 'Review the latest commit, then report again.');

    reviewFindings.record({
      ticket, step: 'adversarial', severity: shipVerdict.verdict, claim: shipVerdict.reasons.join('; '), reasons: shipVerdict.reasons,
      sha: shipVerdict.sha, authorSessionId: caller.id, managerSessionId: manager.sessionId, createdAt: clock(),
    });

    const isNoGo = shipVerdict.verdict === 'no-go';
    if (isNoGo) tellManagerOfNoGo({ managerId: manager.sessionId, body: noGoMessageOf({ ticket, ...shipVerdict }) });
    return ok({ recorded: true, gate: isNoGo ? 'blocked' : 'open' });
  });

  function tellManagerOfNoGo({ managerId, body }: { managerId: string; body: string }): void {
    try {
      sessions.sendMessage({ sessionId: managerId, body, fromSessionId: caller.id });
    } catch (error) {
      log('warn', `ship verdict: could not tell manager ${managerId} of the no-go of reviewer ${caller.id}`, error);
    }
  }
}
