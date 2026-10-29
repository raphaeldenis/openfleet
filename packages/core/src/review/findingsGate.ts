import { isBlankText } from '@openfleet/shared';
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
  const stepReport = reportableSteps.length === 0 ? [] : [`Report ${reportableSteps.join(', ')} with report_step_finding({ step: ${quotedUnion(reportableSteps)}, severity, claims: [...], sha: "${head}" }).`];
  const verdictReport = isAdversarialMissing ? [`The reviewer calls report_ship_verdict({ verdict: "go", reasons: [...], sha: "${head}" }).`] : [];
  const firstWaivableStep = reportableSteps[0];
  const skipCommand = firstWaivableStep === undefined ? [] : [
    `A human can waive ${reportableSteps.join(', ')} with the admin token: curl -X POST <daemon-url>${SKIP_ENDPOINT} -H "Authorization: Bearer <admin token>" -H "Content-Type: application/json" -d '{"ticket":"${ticket}","step":"${firstWaivableStep}","reason":"...","sha":"${head}"}'`,
  ];
  return [...stepReport, ...verdictReport, ...skipCommand].join(' ');
}

/** One short sentence, so the refusal text keeps room for the alternative that carries the skip command. */
function noEvidenceNoteOf(steps: string[]): string {
  if (steps.length === 0) return '';
  if (steps.length === 1) return ` ${steps[0]} line has no evidence.`;
  return ` ${steps.join(', ')} lines have no evidence.`;
}

const isPassing =(line: ReviewFinding) => line.severity !== 'no-go';
const hasEvidence = (line: ReviewFinding) => line.reasons.some((reason) => !isBlankText(reason));
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

    const { missing, withoutEvidence } = this.missingFindingsOf({ ticket, head });
    if (missing.length === 0) return OPEN;
    return this.closed({
      reason: `findings_required: ${ticket} @${head.slice(0, SHORT_SHA_LENGTH)} lacks ${missing.join(', ')}.${noEvidenceNoteOf(withoutEvidence)}`,
      alternative: howToLogOf({ ticket, head, missing }),
    });
  }

  private closed({ reason, alternative }: { reason: string; alternative: string }): GateAnswer {
    return { isOpen: false, reason, alternative };
  }

  /** The steps with no usable line, and among them the steps whose line exists but states no evidence. */
  private missingFindingsOf({ ticket, head }: { ticket: string; head: string }): { missing: string[]; withoutEvidence: string[] } {
    const lines = this.deps.findings.linesOf({ ticket });
    const skippedSteps = new Set(this.deps.findings.skipsOf({ ticket }).map((skip) => skip.step));
    const latestAtHead = (step: ReviewFinding['step']) => latestOf(lines.filter((line) => line.step === step && line.sha === head));

    const hasStrictLine = (step: 'qe' | 'qa') => {
      const latest = latestAtHead(step);
      return skippedSteps.has(step) || (latest !== undefined && isPassing(latest) && hasEvidence(latest));
    };
    const ponytailLines = lines.filter((line) => line.step === 'ponytail');
    const hasPonytailLine = skippedSteps.has('ponytail') || ponytailLines.some(hasEvidence);
    const latestAdversarial = latestAtHead('adversarial');
    const hasGoAtHead = latestAdversarial?.severity === 'go' && hasEvidence(latestAdversarial);

    const isPassingWithoutEvidence = (line: ReviewFinding | undefined) => line !== undefined && isPassing(line) && !hasEvidence(line);
    return {
      missing: [
        ...(hasStrictLine('qe') ? [] : ['qe']),
        ...(hasStrictLine('qa') ? [] : ['qa']),
        ...(hasPonytailLine ? [] : ['ponytail']),
        ...(hasGoAtHead ? [] : [ADVERSARIAL_MISSING]),
      ],
      withoutEvidence: [
        ...(!hasStrictLine('qe') && isPassingWithoutEvidence(latestAtHead('qe')) ? ['qe'] : []),
        ...(!hasStrictLine('qa') && isPassingWithoutEvidence(latestAtHead('qa')) ? ['qa'] : []),
        ...(!hasPonytailLine && ponytailLines.length > 0 ? ['ponytail'] : []),
        ...(!hasGoAtHead && latestAdversarial?.severity === 'go' ? ['adversarial'] : []),
      ],
    };
  }
}
