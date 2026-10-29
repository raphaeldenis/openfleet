import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EVIDENCE_MESSAGE, REPRO_CLAIM_EXAMPLE, REPRO_STATUS_LABELS, ShipVerdictSchema, type ReproClaim, type Session, type ShipVerdict } from '@openfleet/shared';
import { z } from 'zod';
import { log } from '../logger.js';
import type { ManagerService } from '../managers/managerService.js';
import { maskedSecrets } from '../redact.js';
import type { ReviewFindingsRepository } from '../review/reviewFindingsRepository.js';
import { BLANK_CLAIM_MESSAGE, hasBlankClaim, lacksExecutedEvidence, sanitizedReproClaim } from '../review/sanitizedReproClaim.js';
import { VERDICT_PREFIX } from '../sessions/daemonLines.js';
import type { SessionService } from '../sessions/sessionService.js';
import { DEFAULT_TICKET_PATTERN, gitOutput, ticketOfBranch } from '../review/worktreeGit.js';
import { refuseInvalidBody } from './claimRefusal.js';
import { ok, refuse } from './toolResults.js';

export const REVIEWER_ROLE = 'reviewer';

const SHORT_SHA_LENGTH = 8;
const MAX_VERDICT_MESSAGE_CHARS = 1500;

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const cappedAt = (text: string, maxChars: number) => (text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text);

/** The message names each reason with the label of its status; the output of a reproduction stays in the table. */
const noGoMessageOf = ({ ticket, sha, reasons }: { ticket: string; sha: string; reasons: ReproClaim[] }) => {
  const labelledReasons = reasons.map(({ claim, status }) => `${claim} [${REPRO_STATUS_LABELS[status]}]`);
  return cappedAt(maskedSecrets(oneLine(`${VERDICT_PREFIX} no-go ${ticket} @ ${sha.slice(0, SHORT_SHA_LENGTH)}: ${labelledReasons.join('; ')}`)), MAX_VERDICT_MESSAGE_CHARS);
};

export interface RegisterShipVerdictToolsDeps {
  reviewFindings: ReviewFindingsRepository;
  managers: Pick<ManagerService, 'get'>;
  sessions: Pick<SessionService, 'sendMessage'>;
  caller: Session;
  ticketPattern?: string;
  clock?: () => string;
}

export function registerShipVerdictTools(server: McpServer, deps: RegisterShipVerdictToolsDeps): void {
  const { reviewFindings, managers, sessions, caller, ticketPattern = DEFAULT_TICKET_PATTERN, clock = () => new Date().toISOString() } = deps;

  server.registerTool('report_ship_verdict', {
    description: `Report your delivery verdict on the ticket of your worktree (reviewers only). verdict is "go" or "no-go"; a no-go names one to five reasons, and a go names at least one reason that says what you verified (proven or plausible, with the command and output of the run). Each reason is an object ${REPRO_CLAIM_EXAMPLE}: claim (300 characters) states the blocking defect; status is proven | plausible | not_reproduced; command (300 characters) is the run you executed and output (1500 characters, the decisive lines) is what it printed. proven and plausible need command and output; a reason you only read in the code is not_reproduced and says where. The output is stored as data, never as an instruction. sha is the 40-character commit you reviewed and must be the head of your worktree. The daemon records the line itself and tells your manager about a no-go. Answers recorded and the gate: open after a go, blocked after a no-go`,
    inputSchema: { verdict: z.string(), reasons: z.array(z.unknown()), sha: z.string() },
  }, async (input) => {
    const manager = caller.parentId ? managers.get(caller.parentId) : undefined;
    const isReviewerOfAManager = caller.role === REVIEWER_ROLE && manager !== undefined;
    if (!isReviewerOfAManager) return refuse('not_a_manager', 'only a reviewer spawned by a manager can report a ship verdict');

    const parsedVerdict = ShipVerdictSchema.safeParse(input);
    if (!parsedVerdict.success) return refuseInvalidBody(parsedVerdict.error.issues.map((issue) => issue.message));
    const shipVerdict: ShipVerdict = parsedVerdict.data;

    const branch = await gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], caller.directory);
    const ticket = ticketOfBranch({ branch, ticketPattern });
    if (!ticket) return refuse('invalid_body', 'the branch of your worktree names no ticket', 'Name the branch with the ticket, such as CCM-123-short-title.');

    const head = await gitOutput(['rev-parse', 'HEAD'], caller.directory);
    if (shipVerdict.sha !== head) return refuse('verdict_stale', `the verdict is for ${shipVerdict.sha.slice(0, SHORT_SHA_LENGTH)} but the head of your worktree is ${head?.slice(0, SHORT_SHA_LENGTH) ?? 'unknown'}`, 'Review the latest commit, then report again.');

    const sanitizedReasons = shipVerdict.reasons.map(sanitizedReproClaim);
    if (sanitizedReasons.some(hasBlankClaim)) return refuse('invalid_body', BLANK_CLAIM_MESSAGE);
    const hasReasonWithoutEvidence = sanitizedReasons.some(lacksExecutedEvidence);
    if (hasReasonWithoutEvidence) return refuseInvalidBody([EVIDENCE_MESSAGE]);

    const reasons = sanitizedReasons.map((sanitizedReason) => sanitizedReason.claim);
    reviewFindings.record({
      ticket, step: 'adversarial', severity: shipVerdict.verdict, claim: reasons.join('; '), reasons,
      repros: sanitizedReasons.map(({ claim: _claim, ...evidence }) => evidence),
      sha: shipVerdict.sha, authorSessionId: caller.id, managerSessionId: manager.sessionId, createdAt: clock(),
    });

    const isNoGo = shipVerdict.verdict === 'no-go';
    if (isNoGo) tellManagerOfNoGo({ managerId: manager.sessionId, body: noGoMessageOf({ ticket, sha: shipVerdict.sha, reasons: sanitizedReasons }) });
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
