import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { makeRepo } from '../git/testRepo.js';
import { refusalTextOf } from '../policy/refusalText.js';
import { childEnvironmentForGit } from '../process/childEnvironment.js';
import { FindingsGate } from './findingsGate.js';

const LONG_TICKET_BRANCH = 'CCM-4665-sales-amount-detail-page';
const nothingLogged = { linesOf: () => [], skipsOf: () => [] };

const repoOnBranch = (branch: string) => {
  const repo = makeRepo();
  execFileSync('git', ['checkout', '-b', branch], { cwd: repo, env: childEnvironmentForGit(process.env) });
  return repo;
};

describe('the findings gate refusal, as the session reads it after truncation', () => {
  it('ends the skip command with its complete JSON body when every step is missing and no human is watching', async () => {
    const gate = new FindingsGate({ findings: nothingLogged, ticketPattern: '[A-Z]+-\\d+' });
    const answer = await gate.check({ directory: repoOnBranch(LONG_TICKET_BRANCH) });
    if (answer.isOpen) throw new Error('the gate should be closed');

    const refusalText = refusalTextOf({ ruleId: 'findings_required', reason: answer.reason, alternative: answer.alternative, isUnwatched: true });

    const skipCommand = refusalText.slice(refusalText.indexOf('curl -X POST'), refusalText.indexOf('}\'') + 2);
    expect(refusalText).toContain('qe, qa, ponytail, adversarial go');
    expect(skipCommand).toMatch(/-d '\{"ticket":"CCM-4665","step":"qe","reason":"\.\.\.","sha":"[0-9a-f]{40}"\}'$/);
  });

  it('keeps the complete skip command when every logged line has no evidence', async () => {
    const repo = repoOnBranch(LONG_TICKET_BRANCH);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, env: childEnvironmentForGit(process.env), encoding: 'utf8' }).trim();
    const lineWithoutEvidence = (step: 'qe' | 'qa' | 'ponytail' | 'adversarial', severity: 'clean' | 'go') =>
      ({ ticket: 'CCM-4665', step, severity, claim: '', reasons: [''], sha: head, authorSessionId: 'a', managerSessionId: null, createdAt: 't0' });
    const findings = { linesOf: () => [lineWithoutEvidence('qe', 'clean'), lineWithoutEvidence('qa', 'clean'), lineWithoutEvidence('ponytail', 'clean'), lineWithoutEvidence('adversarial', 'go')], skipsOf: () => [] };
    const answer = await new FindingsGate({ findings, ticketPattern: '[A-Z]+-\\d+' }).check({ directory: repo });
    if (answer.isOpen) throw new Error('the gate should be closed');

    const refusalText = refusalTextOf({ ruleId: 'findings_required', reason: answer.reason, alternative: answer.alternative, isUnwatched: true });

    const skipCommand = refusalText.slice(refusalText.indexOf('curl -X POST'), refusalText.indexOf('}\'') + 2);
    expect(refusalText).toContain('qe, qa, ponytail, adversarial lines have no evidence');
    expect(skipCommand).toMatch(/-d '\{"ticket":"CCM-4665","step":"qe","reason":"\.\.\.","sha":"[0-9a-f]{40}"\}'$/);
  });
});
