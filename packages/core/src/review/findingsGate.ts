import type { ReviewFinding, ReviewFindingsRepository } from './reviewFindingsRepository.js';
import { gitOutput, ticketOfBranch } from './worktreeGit.js';

export type FindingsGateEnforcement = 'observe' | 'enforce';

/**
 * The gate ships observing: a refusal is journaled and the command passes. It stays so until MT-7b delivers the tool
 * through which QE, QA and the reviewer write their lines; without it nobody can open the gate by writing findings.
 */
export const FINDINGS_GATE_ENFORCEMENT: FindingsGateEnforcement = 'observe';

export const SKIP_ENDPOINT = '/api/review-findings/skips';

export type GateAnswer = { isOpen: true } | { isOpen: false; reason: string; alternative: string };

const OPEN: GateAnswer = { isOpen: true };
const SHORT_SHA_LENGTH = 8;

const isPassing = (line: ReviewFinding) => line.severity !== 'no-go';
const latestOf = (lines: ReviewFinding[]) => lines.at(-1);

export interface FindingsGateDeps {
  findings: Pick<ReviewFindingsRepository, 'linesOf' | 'skipsOf'>;
  ticketPattern: string;
}

/** Tells whether the ticket of a worktree has the findings that open a pull request. */
export class FindingsGate {
  constructor(private readonly deps: FindingsGateDeps) {}

  async check({ directory }: { directory: string }): Promise<GateAnswer> {
    const branch = await gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], directory);
    const head = await gitOutput(['rev-parse', 'HEAD'], directory);
    if (branch === undefined || head === undefined) return this.closed({ reason: 'findings_required: the branch and head of this directory cannot be read.', alternative: 'Run gh pr create from the worktree of your ticket.' });

    const ticket = ticketOfBranch({ branch, ticketPattern: this.deps.ticketPattern });
    if (ticket === undefined) return this.closed({ reason: `findings_required: branch ${branch} names no ticket.`, alternative: 'Name the branch with the ticket, such as CCM-123-short-title.' });

    const missing = this.missingFindingsOf({ ticket, head });
    if (missing.length === 0) return OPEN;
    return this.closed({
      reason: `findings_required: ${ticket} @${head.slice(0, SHORT_SHA_LENGTH)} lacks ${missing.join(', ')}.`,
      alternative: `Report them on the head commit; a human logs a skip: POST ${SKIP_ENDPOINT}`,
    });
  }

  private closed({ reason, alternative }: { reason: string; alternative: string }): GateAnswer {
    return { isOpen: false, reason, alternative };
  }

  private missingFindingsOf({ ticket, head }: { ticket: string; head: string }): string[] {
    const lines = this.deps.findings.linesOf({ ticket });
    const skippedSteps = new Set(this.deps.findings.skipsOf({ ticket }).map((skip) => skip.step));
    const latestAtHead = (step: ReviewFinding['step']) => latestOf(lines.filter((line) => line.step === step && line.sha === head));

    const hasStrictLine = (step: 'qe' | 'qa') => {
      const latest = latestAtHead(step);
      return skippedSteps.has(step) || (latest !== undefined && isPassing(latest));
    };
    const hasPonytailLine = skippedSteps.has('ponytail') || lines.some((line) => line.step === 'ponytail');
    const hasGoAtHead = latestAtHead('adversarial')?.severity === 'go';

    return [
      ...(hasStrictLine('qe') ? [] : ['qe']),
      ...(hasStrictLine('qa') ? [] : ['qa']),
      ...(hasPonytailLine ? [] : ['ponytail']),
      ...(hasGoAtHead ? [] : ['adversarial go']),
    ];
  }
}
