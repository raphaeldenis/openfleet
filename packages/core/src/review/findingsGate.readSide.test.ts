import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { makeRepo } from '../git/testRepo.js';
import { childEnvironmentForGit } from '../process/childEnvironment.js';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../db/migrate.js';
import { FindingsGate } from './findingsGate.js';
import { ReviewFindingsRepository, type FindingStep, type ReviewFinding, type ReproEvidence } from './reviewFindingsRepository.js';

const TICKET = 'CCM-4665';
const provenRun: ReproEvidence = { status: 'proven', command: 'pnpm test', output: '321 passed' };
const readInCode: ReproEvidence = { status: 'not_reproduced' };

const repoOnTicketBranch = () => {
  const repo = makeRepo();
  execFileSync('git', ['checkout', '-b', `${TICKET}-sales-amount`], { cwd: repo, env: childEnvironmentForGit(process.env) });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, env: childEnvironmentForGit(process.env), encoding: 'utf8' }).trim();
  return { repo, head };
};

const lineOf = ({ step, head, repros }: { step: FindingStep; head: string; repros?: ReproEvidence[] }): ReviewFinding => ({
  ticket: TICKET, step, severity: step === 'adversarial' ? 'go' : 'clean', claim: 'qe: 321 tests green', reasons: (repros ?? [undefined]).map((_repro, position) => `qe: 321 tests green ${position}`), sha: head,
  authorSessionId: `${step}-1`, managerSessionId: null, createdAt: '2026-10-29T08:00:00.000Z', ...(repros === undefined ? {} : { repros }),
});

const gateOverRecorded = (lines: ReviewFinding[]) => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  const findings = new ReviewFindingsRepository(db);
  lines.forEach((line) => findings.record(line));
  return new FindingsGate({ findings, ticketPattern: '[A-Z]+-\\d+' });
};

const allStepsWith = (head: string, repros: ReproEvidence[] | undefined) =>
  (['qe', 'qa', 'ponytail', 'adversarial'] as const).map((step) => lineOf({ step, head, repros }));

describe('the findings gate reads a stored clean or go line only when it carries an executed claim', () => {
  it('opens when every step is clean or go with a proven claim', async () => {
    const { repo, head } = repoOnTicketBranch();

    const answer = await gateOverRecorded(allStepsWith(head, [provenRun])).check({ directory: repo });

    expect(answer.isOpen).toBe(true);
  });

  it('stays closed on old-form lines: a textual reason with no claim record', async () => {
    const { repo, head } = repoOnTicketBranch();

    const answer = await gateOverRecorded(allStepsWith(head, undefined)).check({ directory: repo });

    expect(answer).toMatchObject({ isOpen: false, reason: expect.stringContaining('lacks qe, qa, ponytail, adversarial go') });
  });

  it('stays closed on lines whose only claim is not_reproduced', async () => {
    const { repo, head } = repoOnTicketBranch();

    const answer = await gateOverRecorded(allStepsWith(head, [readInCode])).check({ directory: repo });

    expect(answer).toMatchObject({ isOpen: false, reason: expect.stringContaining('lacks qe, qa, ponytail, adversarial go') });
  });

  it('opens when a not_reproduced claim comes with a proven one', async () => {
    const { repo, head } = repoOnTicketBranch();

    const answer = await gateOverRecorded(allStepsWith(head, [readInCode, provenRun])).check({ directory: repo });

    expect(answer.isOpen).toBe(true);
  });

  it('names the old-form lines as lines without evidence', async () => {
    const { repo, head } = repoOnTicketBranch();

    const answer = await gateOverRecorded(allStepsWith(head, undefined)).check({ directory: repo });

    expect(answer).toMatchObject({ reason: expect.stringContaining('qe, qa, ponytail, adversarial lines have no evidence') });
  });

  it('refuses a step logged in the old form, then opens once the step is reported again with a proven claim', async () => {
    const { repo, head } = repoOnTicketBranch();
    const otherStepsWithEvidence = (['qe', 'ponytail', 'adversarial'] as const).map((step) => lineOf({ step, head, repros: [provenRun] }));
    const qaInOldForm = { ...lineOf({ step: 'qa', head, repros: undefined }), authorSessionId: 'qa-before-the-rule' };
    const qaReportedAgain = lineOf({ step: 'qa', head, repros: [provenRun] });

    const refusedAnswer = await gateOverRecorded([...otherStepsWithEvidence, qaInOldForm]).check({ directory: repo });
    const reportedAgainAnswer = await gateOverRecorded([...otherStepsWithEvidence, qaInOldForm, qaReportedAgain]).check({ directory: repo });

    expect(refusedAnswer).toMatchObject({ isOpen: false, reason: expect.stringContaining('qa line has no evidence') });
    expect(reportedAgainAnswer.isOpen).toBe(true);
  });
});
