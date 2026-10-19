import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StepFindingSchema, type Session, type StepFinding } from '@openfleet/shared';
import { z } from 'zod';
import type { ManagerService } from '../managers/managerService.js';
import { maskedSecrets } from '../redact.js';
import type { FindingSeverity, FindingStep, ReviewFindingsRepository } from '../review/reviewFindingsRepository.js';
import { DEFAULT_TICKET_PATTERN, gitOutput, ticketOfBranch } from '../review/worktreeGit.js';
import { ok, refuse } from './toolResults.js';

/** Each reporting role writes the line of its own step and no other. */
const STEP_OF_ROLE: Readonly<Record<string, FindingStep>> = { qe: 'qe', qa: 'qa', ponytail: 'ponytail' };

/** Rows of qe/qa/ponytail with severity no-go mean findings; the CHECK of 033 has no 'findings'. */
const STORED_SEVERITY_OF_FINDINGS: FindingSeverity = 'no-go';
const storedSeverityOf = (severity: StepFinding['severity']): FindingSeverity => (severity === 'findings' ? STORED_SEVERITY_OF_FINDINGS : 'clean');

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const SHORT_SHA_LENGTH = 8;

export interface RegisterStepFindingToolsDeps {
  reviewFindings: ReviewFindingsRepository;
  managers: Pick<ManagerService, 'get'>;
  caller: Session;
  ticketPattern?: string;
  clock?: () => string;
}

export function registerStepFindingTools(server: McpServer, deps: RegisterStepFindingToolsDeps): void {
  const { reviewFindings, managers, caller, ticketPattern = DEFAULT_TICKET_PATTERN, clock = () => new Date().toISOString() } = deps;

  server.registerTool('report_step_finding', {
    description: 'Report the findings of your review step on the ticket of your worktree (roles qe, qa and ponytail, spawned by a manager; each role reports its own step). severity is "clean" or "findings"; findings name one to five claims (300 characters each); sha is the 40-character commit you checked: the head of your worktree (for ponytail, the head or one of its ancestors). The daemon records the line itself. Answers recorded, the step and the severity',
    inputSchema: { step: z.string(), severity: z.string(), claims: z.array(z.string()), sha: z.string() },
  }, async (input) => {
    const manager = caller.parentId ? managers.get(caller.parentId) : undefined;
    const stepOfCaller = caller.role === undefined ? undefined : STEP_OF_ROLE[caller.role];
    const isReporterOfAManager = stepOfCaller !== undefined && manager !== undefined;
    if (!isReporterOfAManager) return refuse('not_a_manager', 'only a qe, qa or ponytail session spawned by a manager can report a step finding');

    const parsedFinding = StepFindingSchema.safeParse(input);
    if (!parsedFinding.success) return refuse('invalid_body', parsedFinding.error.issues.map((issue) => issue.message).join('; '));
    const stepFinding = parsedFinding.data;
    if (stepFinding.step !== stepOfCaller) return refuse('not_a_manager', `a ${caller.role} session reports the ${stepOfCaller} step only`);

    const branch = await gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], caller.directory);
    const ticket = ticketOfBranch({ branch, ticketPattern });
    if (!ticket) return refuse('invalid_body', 'the branch of your worktree names no ticket', 'Name the branch with the ticket, such as CCM-123-short-title.');

    const head = await gitOutput(['rev-parse', 'HEAD'], caller.directory);
    const isHead = stepFinding.sha === head;
    const mayBeAncestorOfHead = stepFinding.step === 'ponytail' && !isHead;
    const isAncestorOfHead = mayBeAncestorOfHead && await gitOutput(['merge-base', '--is-ancestor', stepFinding.sha, 'HEAD'], caller.directory) !== undefined;
    if (!isHead && !isAncestorOfHead) return refuse('verdict_stale', `the report is for ${stepFinding.sha.slice(0, SHORT_SHA_LENGTH)} but the head of your worktree is ${head?.slice(0, SHORT_SHA_LENGTH) ?? 'unknown'}`, 'Check the latest commit, then report again.');

    const claims = stepFinding.claims.map((claim) => maskedSecrets(oneLine(claim)));
    reviewFindings.record({
      ticket, step: stepFinding.step, severity: storedSeverityOf(stepFinding.severity), claim: claims.join('; '), reasons: claims,
      sha: stepFinding.sha, authorSessionId: caller.id, managerSessionId: manager.sessionId, createdAt: clock(),
    });
    return ok({ recorded: true, step: stepFinding.step, severity: stepFinding.severity });
  });
}
