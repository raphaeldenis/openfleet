import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMAND_POLICY, FINDINGS_GATE_RULE_ID } from './defaultCommandPolicy.js';
import { evaluateCommandPolicy } from './policyEvaluator.js';
import { bashRequest } from './policyRequest.testkit.js';

const enforcing = { ...DEFAULT_COMMAND_POLICY, mode: 'enforce' as const };
const observing = { ...DEFAULT_COMMAND_POLICY, mode: 'observe' as const };

const matchesTheGateRule = (command: string, role?: string) => {
  const verdict = evaluateCommandPolicy(bashRequest(command, role === undefined ? {} : { role }), enforcing);
  const isRefused = verdict.decision === 'deny' && verdict.ruleId === FINDINGS_GATE_RULE_ID;
  const isObserved = verdict.decision === 'allow' && verdict.observed?.ruleId === FINDINGS_GATE_RULE_ID;
  return isRefused || isObserved;
};

describe('the findings gate rule delivered with the command policy', () => {
  it.each([
    ['a plain gh pr create', 'gh pr create --title "x" --body y'],
    ['after &&', 'git push -u origin HEAD && gh pr create --fill'],
    ['in a pipeline', 'echo y | gh pr create --fill'],
    ['after a semicolon', 'true; gh pr create'],
    ['in a command substitution', 'echo "$(gh pr create --fill)"'],
    ['in a subshell', '(gh pr create --fill)'],
  ])('matches %s', (_label, command) => {
    expect(matchesTheGateRule(command)).toBe(true);
  });

  it.each([
    ['gh pr list', 'gh pr list'],
    ['gh pr view', 'gh pr view 12'],
    ['git push alone', 'git push origin HEAD'],
    ['gh pr create quoted as an argument', 'echo "gh pr create"'],
  ])('does not match %s', (_label, command) => {
    expect(matchesTheGateRule(command)).toBe(false);
  });

  it.each([
    ['a nested shell string', 'bash -c "gh pr create --fill"'],
    ['a wrapper command', 'env GH_PROMPT_DISABLED=1 gh pr create --fill'],
    ['xargs', 'echo x | xargs gh pr create'],
    ['eval', 'eval "gh pr create --fill"'],
  ])('matches behind %s', (_label, command) => {
    expect(matchesTheGateRule(command)).toBe(true);
  });

  it('does not see through a script file (documented limit)', () => {
    expect(matchesTheGateRule('bash ./open-pr.sh')).toBe(false);
  });

  it('applies to every role, a DEV and a manager alike', () => {
    expect(matchesTheGateRule('gh pr create', 'DEV')).toBe(true);
    expect(matchesTheGateRule('gh pr create', 'QA')).toBe(true);
    expect(matchesTheGateRule('gh pr create', 'manager')).toBe(true);
  });

  it('is observed, not refused, while the policy observes', () => {
    const verdict = evaluateCommandPolicy(bashRequest('gh pr create'), observing);

    expect(verdict).toMatchObject({ decision: 'allow', observed: { ruleId: FINDINGS_GATE_RULE_ID } });
  });
});
