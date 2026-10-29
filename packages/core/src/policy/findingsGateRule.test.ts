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

  it.each([
    ['an endpoint with a query string', 'gh api repos/o/r/pulls?draft=true -f title=x'],
    ['a quoted endpoint with a query string', 'gh api -X POST "repos/o/r/pulls?x=1"'],
    ['glab with a leading -R', 'glab -R o/r mr create --fill'],
    ['glab with a leading --repo=', 'glab --repo=o/r mr new --fill'],
    ['an endpoint with a slash before the query string', 'gh api repos/o/r/pulls/?x=1 -f title=t'],
    ['an endpoint with a slash before the fragment', 'gh api "repos/o/r/pulls/#frag" -f title=t'],
    ['gh pr with -R between the group and the action', 'gh pr -R o/r create --fill'],
    ['gh pr with --repo= between the group and the action', 'gh pr --repo=o/r create --fill'],
    ['glab mr with -R between the group and the action', 'glab mr -R o/r create --fill'],
    ['glab mr with --repo between the group and the action', 'glab mr --repo o/r new --fill'],
  ])('matches %s', (_label, command) => {
    expect(matchesTheGateRule(command)).toBe(true);
  });

  it.each([
    ['a listing of merge requests behind -R', 'glab -R o/r mr list'],
    ['a listing of merge requests with -R after the group', 'glab mr -R o/r list'],
    ['a view of a pull request with -R after the group', 'gh pr -R o/r view 3'],
    ['the comments of a pull request', 'gh api repos/o/r/pulls/12/comments -f body=x'],
    ['the comments of a pull request behind a query string', 'gh api repos/o/r/pulls/12/comments?page=2 -f body=x'],
  ])('does not match %s', (_label, command) => {
    expect(matchesTheGateRule(command)).toBe(false);
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
