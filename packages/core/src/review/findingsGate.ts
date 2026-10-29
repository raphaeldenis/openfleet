import type { ReviewFinding, ReviewFindingsRepository } from './reviewFindingsRepository.js';
import { gitOutput, ticketOfBranch } from './worktreeGit.js';

export type FindingsGateEnforcement = 'observe' | 'enforce';

/**
 * The gate ships enforcing: a refusal is journaled as denied and the command is blocked; `findingsGate.enforcement: 'observe'`
 * journals it and lets the command pass. `gh pr create --head` is judged on the named branch; a `cd X &&` or `git -C X`
 * before the command is not followed.
 */
export const FINDINGS_GATE_ENFORCEMENT: FindingsGateEnforcement = 'enforce';

export const SKIP_ENDPOINT = '/api/review-findings/skips';

export type GateAnswer = { isOpen: true } | { isOpen: false; reason: string; alternative: string };

const OPEN: GateAnswer = { isOpen: true };
const SHORT_SHA_LENGTH = 8;

function unreadableAnswerOf(headBranch: string | undefined): { reason: string; alternative: string } {
  if (headBranch === undefined) return { reason: 'findings_required: the branch and head of this directory cannot be read.', alternative: 'Run gh pr create from the worktree of your ticket.' };
  return {
    reason: `findings_required: the head commit of branch ${headBranch} (--head) cannot be read as a local branch of this directory.`,
    alternative: `Run gh pr create from the worktree of ${headBranch}, or fetch the branch into this repository first.`,
  };
}

const ADVERSARIAL_MISSING = 'adversarial go';

const quotedUnion = (steps: string[]) => steps.map((step) => `"${step}"`).join(' | ');

/** The tool calls that log each missing step at the head, and the command a human runs, with the admin token kept out of the text, to waive the steps that may be waived. */
function howToLogOf({ ticket, head, missing }: { ticket: string; head: string; missing: string[] }): string {
  const reportableSteps = missing.filter((step) => step !== ADVERSARIAL_MISSING);
  const isAdversarialMissing = missing.includes(ADVERSARIAL_MISSING);
  const stepReport = reportableSteps.length === 0 ? [] : [`Report ${reportableSteps.join(', ')} on the head commit with report_step_finding({ step: ${quotedUnion(reportableSteps)}, severity, claims: [...], sha: "${head}" }).`];
  const verdictReport = isAdversarialMissing ? [`The reviewer reports the delivery verdict with report_ship_verdict({ verdict: "go", reasons: [...], sha: "${head}" }).`] : [];
  const firstWaivableStep = reportableSteps[0];
  const skipCommand = firstWaivableStep === undefined ? [] : [
    `A human can waive ${reportableSteps.join(', ')} with the admin token: curl -X POST <daemon-url>${SKIP_ENDPOINT} -H "Authorization: Bearer <admin token>" -H "Content-Type: application/json" -d '{"ticket":"${ticket}","step":"${firstWaivableStep}","reason":"...","sha":"${head}"}'`,
  ];
  return [...stepReport, ...verdictReport, ...skipCommand].join(' ');
}

const isPassing =(line: ReviewFinding) => line.severity !== 'no-go';
const latestOf = (lines: ReviewFinding[]) => lines.at(-1);

export interface FindingsGateDeps {
  findings: Pick<ReviewFindingsRepository, 'linesOf' | 'skipsOf'>;
  ticketPattern: string;
}

/** Tells whether the ticket of a worktree has the findings that open a pull request. */
export class FindingsGate {
  constructor(private readonly deps: FindingsGateDeps) {}

  /** Judges the branch checked out in `directory`, or the local branch `headBranch` when the command names one with `--head`. */
  async check({ directory, headBranch }: { directory: string; headBranch?: string }): Promise<GateAnswer> {
    const branch = headBranch ?? (await gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], directory));
    const head = await gitOutput(['rev-parse', headBranch === undefined ? 'HEAD' : `refs/heads/${headBranch}`], directory);
    if (branch === undefined || head === undefined) return this.closed(unreadableAnswerOf(headBranch));

    const ticket = ticketOfBranch({ branch, ticketPattern: this.deps.ticketPattern });
    if (ticket === undefined) return this.closed({ reason: `findings_required: branch ${branch} names no ticket.`, alternative: 'Name the branch with the ticket, such as CCM-123-short-title.' });

    const missing = this.missingFindingsOf({ ticket, head });
    if (missing.length === 0) return OPEN;
    return this.closed({
      reason: `findings_required: ${ticket} @${head.slice(0, SHORT_SHA_LENGTH)} lacks ${missing.join(', ')}.`,
      alternative: howToLogOf({ ticket, head, missing }),
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
      ...(hasGoAtHead ? [] : [ADVERSARIAL_MISSING]),
    ];
  }
}
