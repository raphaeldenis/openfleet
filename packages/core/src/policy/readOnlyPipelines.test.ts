import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMAND_POLICY } from './defaultCommandPolicy.js';
import { evaluateCommandPolicy } from './policyEvaluator.js';
import { bashRequest } from './policyRequest.testkit.js';

const WORKTREE = '/work/repo';
const SCRATCH = '/tmp/scratch';
const TOOL_RESULTS = '/home/me/.claude/projects/p/tool-results';
const READ_ONLY_RULE_ID = 'allow-read-only-pipelines';
const workingDirectories = { cwd: WORKTREE, worktreeRoot: WORKTREE, scratchRoots: [SCRATCH], toolResultsRoot: TOOL_RESULTS };

const verdictOf = (command: string, overrides = {}) =>
  evaluateCommandPolicy(bashRequest(command, { ...workingDirectories, ...overrides }), DEFAULT_COMMAND_POLICY);
const isAllowedByRule = (command: string, overrides = {}) => {
  const verdict = verdictOf(command, overrides);
  return verdict.decision === 'allow' && verdict.allowedBy === READ_ONLY_RULE_ID;
};

describe('the read-only pipeline allow rule: what it lets through', () => {
  it('lets through the incident command: a sed substitution read on a tool-results file piped to grep', () => {
    const incident = `sed 's/x/y/' ${TOOL_RESULTS}/toolu_01.txt | grep -n z`;

    expect(verdictOf(incident)).toEqual({ decision: 'allow', allowedBy: READ_ONLY_RULE_ID });
  });

  it.each([
    "sed 's/x/y/' notes.txt",
    "sed -n '1,20p' notes.txt",
    "sed -e 's/a/b/g' -e '/c/d' notes.txt",
    "sed -E 's/(a|b)+/c/Ig' src/a.ts",
    "sed -n '$p' notes.txt",
    'grep -rn foo src',
    'grep -n z notes.txt 2>/dev/null',
    'rg -n foo',
    'cat src/a.ts | head -n 20',
    `cat ${TOOL_RESULTS}/out.txt | head`,
    `head -n 5 ${SCRATCH}/log.txt`,
    'ls -la',
    'ls /work/repo/src',
    'wc -l a.txt b.txt',
    "find . -name '*.ts' | wc -l",
    'tail -n 5 f | sort | uniq -c | sort -rn | head',
    "awk '{print $1}' data.csv",
    "cut -d: -f1 data.csv | tr a-z A-Z",
    'cat < notes.txt',
    '(cat a.txt; cat b.txt) | wc -l',
    'cat ./src/../README.md',
  ])('lets through %j', (command) => {
    expect(isAllowedByRule(command)).toBe(true);
  });

  it('lets through the same reads for an attended session', () => {
    expect(isAllowedByRule('grep -n z notes.txt', { presence: 'attended' })).toBe(true);
  });
});

describe('the read-only pipeline allow rule: reads outside the working directories', () => {
  it.each([
    'grep -n z /etc/passwd',
    'cat ~/.ssh/config',
    'cat /Users/other/notes.txt',
    'ls ..',
    'cat ../secret.txt',
    'cat src/../../secret.txt',
    `cat ${TOOL_RESULTS}/../other/f.txt`,
    'cat /work/repository/f.txt',
    'cat < /etc/hosts',
    'sed "s/x/y/" /etc/hosts | grep z',
  ])('does not vouch for %j', (command) => {
    expect(isAllowedByRule(command)).toBe(false);
  });

  it('does not vouch for anything without any working directory to read from', () => {
    expect(isAllowedByRule('cat f.txt', { worktreeRoot: undefined, scratchRoots: [], toolResultsRoot: undefined })).toBe(false);
  });
});

describe('the read-only pipeline allow rule: what it never lets through', () => {
  it.each([
    "sed -i 's/x/y/' f", "sed -i.bak 's/x/y/' f", "sed --in-place 's/x/y/' f", "sed -ni 's/x/y/p' f",
    "sed 's/x/y/w out.txt' f", "sed 's/x/y/e' f", "sed 'w out.txt' f", "sed '1e echo hi' f", "sed -f script.sed f",
    "sed 's/x/y/;w out' f", "sed -s -n 'F' f",
    "awk '{system(\"id\")}' f", "awk '{print > \"out\"}' f", "awk '{print | \"sh\"}' f", "awk -f prog.awk f", "awk '{ \"date\" | getline d }' f",
    'find . -delete', 'find . -exec cat {} +', 'find . -execdir cat {} \\;', 'find . -fprint out.txt', 'find . -ok cat {} \\;',
    'sort -o out.txt f', 'sort --output=out.txt f', 'uniq in.txt out.txt', 'rg --pre cat foo', 'rg --pre=cat foo',
    'cat f > out.txt', 'cat f >> out.txt', 'cat f &> out.txt', 'cat f 2> err.txt', 'cat f >| out.txt',
    'grep x f | tee out.txt', 'cat f; rm x', 'cat f && git status',
    'cat $(echo f)', 'cat `echo f`', 'cat "$HOME/f"', 'cat $F', 'cat <(echo f)',
    'FOO=1 cat f', 'env cat f', "bash -c 'cat f'", 'eval cat f', 'cat <<EOF\nbody\nEOF', 'cat <<< text',
    "cat 'unterminated", 'cat f | grep "unterminated',
    'xargs cat', 'cat f | xargs rm',
  ])('does not vouch for %j', (command) => {
    expect(isAllowedByRule(command)).toBe(false);
  });
});

describe('the read-only pipeline allow rule: precedence', () => {
  it('never overrides a refusal', () => {
    expect(verdictOf('cat f | sh -c "rm -rf x"')).toMatchObject({ decision: 'deny', ruleId: 'no-forced-recursive-rm' });
    expect(verdictOf('find / -name x -delete')).toMatchObject({ decision: 'deny', ruleId: 'no-find-delete-on-broad-paths' });
  });

  it('is, with the inert declared-commands rule, the only explicit permission the delivered policy grants', () => {
    const allowRules = DEFAULT_COMMAND_POLICY.rules.filter((rule) => rule.decision === 'allow');
    const grantingRuleIds = allowRules.filter((rule) => rule.when.runsDeclaredCommand?.length !== 0).map((rule) => rule.id);

    expect(grantingRuleIds).toEqual([READ_ONLY_RULE_ID]);
    expect(allowRules.map((rule) => rule.id)).toEqual([READ_ONLY_RULE_ID, 'allow-declared-commands']);
  });

  it('is not reported when the policy is off', () => {
    expect(evaluateCommandPolicy(bashRequest('cat f', workingDirectories), { ...DEFAULT_COMMAND_POLICY, mode: 'off' })).toEqual({ decision: 'allow' });
  });
});
