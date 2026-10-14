import type { CommandPolicyDocument, PolicyRule } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMAND_POLICY } from './defaultCommandPolicy.js';
import { evaluateCommandPolicy } from './policyEvaluator.js';
import { bashRequest, fileToolRequest, policyRequest } from './policyRequest.testkit.js';

const decisionOf = (command: string, overrides = {}) => evaluateCommandPolicy(bashRequest(command, overrides), DEFAULT_COMMAND_POLICY).decision;
const verdictOf = (command: string, overrides = {}) => evaluateCommandPolicy(bashRequest(command, overrides), DEFAULT_COMMAND_POLICY);

const aRule = (overrides: Partial<PolicyRule> & Pick<PolicyRule, 'id'>): PolicyRule => ({
  decision: 'deny', when: { program: 'rm' }, reason: 'rm is refused.', alternative: 'Use trash.', ...overrides,
});
const policyWith = (rules: PolicyRule[], overrides: Partial<CommandPolicyDocument> = {}): CommandPolicyDocument => ({
  version: 1, mode: 'enforce',
  profiles: { default: { rules: rules.map((rule) => rule.id) } },
  roleToProfile: {},
  rules,
  ...overrides,
});

const nestedInShells = (script: string, shells: string[]): string =>
  shells.reduce((inner, shell) => `${shell} -c '${inner.replaceAll("'", `'\\''`)}'`, script);

describe('the delivered policy refuses what nobody could confirm', () => {
  it.each([
    'rm -rf x', 'rm -fr x', 'rm --recursive --force x', 'rm -Rf x', 'rm -r -f x', 'rm -rfv x', '/bin/rm -rf x',
    'cd /tmp && rm -rf build', 'ls | xargs rm -rf', 'find . -name x -exec rm -rf {} \\;',
    "sh -c 'rm -rf x'", `sh -c "bash -c 'rm -rf x'"`, 'echo $(rm -rf x)', '(rm -rf x)', 'eval "rm -rf x"',
    nestedInShells('rm -rf x', ['bash', 'sh', 'zsh', 'bash']),
  ])('denies %s with the rule, a reason and an alternative', (command) => {
    const verdict = verdictOf(command);

    expect(verdict).toMatchObject({ decision: 'deny', ruleId: 'no-forced-recursive-rm' });
    expect(verdict.decision === 'deny' && verdict.reason).toMatch(/rm -rf/);
    expect(verdict.decision === 'deny' && verdict.alternative).toMatch(/rm -r/);
  });

  it.each(['rm -r x', 'rm x', 'rm -f x', 'rm -- -rf', "echo 'rm -rf x'", 'grep "rm -rf" notes.txt', "bash -c 'rm -r build'"])(
    'allows %s', (command) => {
      expect(decisionOf(command)).toBe('allow');
    },
  );

  it.each(['git clean -fdx', 'git clean -f', 'git clean --force -d', 'git -C sub clean -fd', "sh -c 'git clean -fdx'"])(
    'denies %s as a forced git clean', (command) => {
      expect(verdictOf(command)).toMatchObject({ decision: 'deny', ruleId: 'no-forced-git-clean' });
    },
  );

  it.each(['git clean -n', 'git clean -nfd', 'git clean --dry-run -fd', 'git clean', 'git status', 'git checkout -- .'])(
    'allows %s', (command) => {
      expect(decisionOf(command)).toBe('allow');
    },
  );

  it.each([
    'echo hi >> .git/info/exclude', 'echo hi > .git/info/exclude', 'echo hi>.git/info/exclude', 'echo hi >> ../../.git/info/exclude',
    'echo hi >> /Users/me/repo/.git/info/exclude', 'echo hi | tee .git/info/exclude', 'echo hi | tee -a .git/info/exclude',
    'cp a .git/hooks/pre-commit', 'mv -f a .git/hooks/pre-commit', "sh -c 'echo hi >> .git/info/exclude'",
    'echo hi 2> .git/err', 'echo hi > ".git/x"', 'echo hi &> sub/.git/x', 'echo hi >| .git',
  ])('denies the write %s into a .git directory', (command) => {
    expect(verdictOf(command)).toMatchObject({ decision: 'deny', ruleId: 'no-write-into-git-dir' });
  });

  it.each([
    'echo hi >> .gitignore', 'echo hi > notes.git.txt', 'cat .git/config', 'cp .git/config backup', 'echo hi > .github/x',
    'echo hi > gitfile/.gitkeep', 'git status > out.txt',
  ])('allows %s', (command) => {
    expect(decisionOf(command)).toBe('allow');
  });

  it.each(['Write', 'Edit', 'NotebookEdit'])('denies the %s tool on a file inside .git', (toolName) => {
    const verdict = evaluateCommandPolicy(fileToolRequest(toolName, '/repo/.git/hooks/pre-commit'), DEFAULT_COMMAND_POLICY);

    expect(verdict).toMatchObject({ decision: 'deny', ruleId: 'no-write-into-git-dir' });
  });

  it.each(['/repo/.git', 'a/b/.git/config', '.git/info/exclude'])('denies a file tool on %s', (filePath) => {
    expect(evaluateCommandPolicy(fileToolRequest('Write', filePath), DEFAULT_COMMAND_POLICY).decision).toBe('deny');
  });

  it.each(['/repo/src/app.ts', '/repo/.gitignore', '/repo/.github/workflows/ci.yml', '/repo/notes.git'])(
    'allows the Write tool on %s', (filePath) => {
      expect(evaluateCommandPolicy(fileToolRequest('Write', filePath), DEFAULT_COMMAND_POLICY).decision).toBe('allow');
    },
  );

  it('allows an attended session to run the same commands', () => {
    const attended = { presence: 'attended' } as const;

    expect(decisionOf('rm -rf x', attended)).toBe('allow');
    expect(decisionOf('git clean -fdx', attended)).toBe('allow');
    expect(decisionOf('echo hi >> .git/info/exclude', attended)).toBe('allow');
  });

  // Known limit: the analyzer evaluates no variable, so flags held in a variable stay invisible to the rules.
  it('allows flags held in a variable (documented limit, not covered)', () => {
    expect(decisionOf('R=-rf; rm $R x')).toBe('allow');
    expect(decisionOf('F=-f; rm -r $F x')).toBe('allow');
  });
});

describe('commands that run another command', () => {
  it.each([
    'xargs rm -rf', 'ls | xargs -n 1 rm -rf', 'find . -name x -exec rm -rf {} +', 'find . -execdir rm -rf {} \\;',
    "xargs sh -c 'rm -rf x'", `eval "sh -c 'rm -rf x'"`, "eval 'eval \"rm -rf x\"'", "sh -c 'eval \"rm -rf x\"'",
    'bash <<EOF\nrm -rf x\nEOF',
  ])('denies the forced rm run by %j', (command) => {
    expect(verdictOf(command)).toMatchObject({ decision: 'deny', ruleId: 'no-forced-recursive-rm' });
  });

  it.each(['find / -delete', 'find / -name x -delete', 'find ~ -delete', 'find ~/projects -delete', 'find $HOME -delete', 'find .. -delete', 'find ../.. -delete'])(
    'denies %s, which deletes outside the worktree', (command) => {
      expect(verdictOf(command)).toMatchObject({ decision: 'deny', ruleId: 'no-find-delete-on-broad-paths' });
    },
  );

  it.each(['find . -delete', 'find build -name "*.o" -delete', 'find ./dist -type f -delete', 'find / -name x', "echo 'find / -delete'"])(
    'allows %s, the alternative the rm rule recommends', (command) => {
      expect(decisionOf(command)).toBe('allow');
    },
  );
});

describe('quoted text that only mentions a dangerous command', () => {
  it.each([
    'grep -rn "rm -rf" chemin/entre/guillemets', 'echo "rm -rf x"', "echo 'git clean -fdx'", 'grep "git clean -f" docs/notes.md',
    'claude -p "run pnpm test then rm -rf the cache"', "codex exec 'pnpm test && rm -rf x'", 'printf "%s\\n" "echo hi >> .git/x"',
  ])('allows %s', (command) => {
    expect(decisionOf(command, { role: 'DEV', model: 'opus', presence: 'unattended' })).toBe('allow');
  });
});

describe('a separator inside a quote never makes a second command', () => {
  it.each([
    "echo 'x; rm -rf y'", 'echo "a && rm -rf b"', "echo 'a | rm -rf b'", "echo $'a\\'; rm -rf b'", "grep -rE 'a|b' src",
    'echo "$(echo ok); not a command"', 'printf "%s" "x & rm -rf y"', "git commit -m 'fix; rm -rf cache'",
  ])('allows %s', (command) => {
    expect(decisionOf(command, { role: 'DEV', model: 'opus' })).toBe('allow');
  });

  it('still denies the real command that follows the quote', () => {
    expect(decisionOf("echo 'a;b' ; rm -rf y")).toBe('deny');
  });
});

describe('the delegation rule', () => {
  const orchestrator = { role: 'DEV', model: 'opus', presence: 'attended' } as const;

  it.each(['pnpm test', 'pnpm lint', 'npx vitest run', 'rg foo', 'cd app && pnpm test', "echo 'a&&b' && pnpm test", "echo 'x'; pnpm build"])(
    'sends %s to a sub-agent', (command) => {
      expect(verdictOf(command, orchestrator)).toMatchObject({ decision: 'deny', ruleId: 'delegate-heavy-commands' });
    },
  );

  it('tells the session which sub-agent to use', () => {
    const verdict = verdictOf('pnpm test', orchestrator);

    expect(verdict.decision === 'deny' && verdict.alternative).toMatch(/Haiku sub-agent/);
  });

  it.each([
    'pnpm test:unit', 'pnpm install', 'git status', "echo 'pnpm_test'", 'grep -r foo /Users/me/x', 'cat file | grep -r foo',
    'ls | head', 'claude -p "run pnpm test and report"', "codex exec 'pnpm test'", 'git commit -m "pnpm test"',
  ])('lets %s run', (command) => {
    expect(decisionOf(command, orchestrator)).toBe('allow');
  });

  it('never blocks a sub-agent', () => {
    expect(decisionOf('pnpm test', { ...orchestrator, actor: 'subagent' })).toBe('allow');
  });

  it('honours the escape marker for an attended session only', () => {
    expect(decisionOf('pnpm test # fix60-ok', orchestrator)).toBe('allow');
    expect(decisionOf('pnpm test # fix60-ok', { ...orchestrator, presence: 'unattended' })).toBe('deny');
  });

  it.each([
    ['a Haiku child', { model: 'haiku' }],
    ['a Sonnet child', { model: 'claude-sonnet-5-5' }],
    ['an unknown model', { model: undefined }],
    ['another harness', { harness: 'fake' as const }],
    ['a role without the dev profile', { role: 'QE' }],
    ['no role at all', { role: undefined }],
  ])('does not apply to %s', (_label, overrides) => {
    expect(decisionOf('pnpm test', { ...orchestrator, ...overrides })).toBe('allow');
  });

  it.each([['fable'], ['claude-opus-5-5'], ['Opus']])('applies to the expensive model %s', (model) => {
    expect(decisionOf('pnpm test', { ...orchestrator, model })).toBe('deny');
  });

  it('reads the dev profile whatever the case of the role', () => {
    expect(decisionOf('pnpm test', { ...orchestrator, role: 'dev' })).toBe('deny');
  });

  it('denies a heavy command wrapped in an inline shell', () => {
    expect(decisionOf(`bash -c "pnpm test"`, orchestrator)).toBe('deny');
  });
});

describe('profiles by role', () => {
  it('applies the default profile to an unknown role and to no role', () => {
    expect(decisionOf('rm -rf x', { role: 'SOMETHING' })).toBe('deny');
    expect(decisionOf('rm -rf x', { role: undefined })).toBe('deny');
  });

  it.each(['QE', 'QA', 'ADV', 'REVIEW', 'qa'])('observes without refusing for the %s role', (role) => {
    const verdict = verdictOf('rm -rf x', { role });

    expect(verdict.decision).toBe('allow');
    expect(verdict).toMatchObject({ observed: { ruleId: 'no-forced-recursive-rm' } });
  });

  it('observes a git push for the QA role and refuses nothing', () => {
    expect(verdictOf('git push origin main', { role: 'QA' })).toMatchObject({ decision: 'allow', observed: { ruleId: 'no-git-publish' } });
  });

  it('observes a file write for the review role', () => {
    const verdict = evaluateCommandPolicy(fileToolRequest('Write', '/repo/src/a.ts', { role: 'REVIEW' }), DEFAULT_COMMAND_POLICY);

    expect(verdict).toMatchObject({ decision: 'allow', observed: { ruleId: 'no-file-writes' } });
  });

  it('does not report an observation when nothing matched', () => {
    expect(verdictOf('git status', { role: 'QE' })).toEqual({ decision: 'allow' });
  });
});

describe('questions to a human nobody reads', () => {
  it.each(['AskUserQuestion', 'ExitPlanMode'])('denies %s for an unattended session and points to the manager', (toolName) => {
    const verdict = evaluateCommandPolicy(policyRequest({ toolName }), DEFAULT_COMMAND_POLICY);

    expect(verdict).toMatchObject({ decision: 'deny' });
    expect(verdict.decision === 'deny' && verdict.alternative).toContain('message_parent');
  });

  it('lets an attended session ask', () => {
    expect(evaluateCommandPolicy(policyRequest({ toolName: 'AskUserQuestion', presence: 'attended' }), DEFAULT_COMMAND_POLICY).decision).toBe('allow');
  });
});

describe('evaluation modes', () => {
  it('allows everything when the mode is off', () => {
    const off = { ...DEFAULT_COMMAND_POLICY, mode: 'off' } as const;

    expect(evaluateCommandPolicy(bashRequest('rm -rf x'), off)).toEqual({ decision: 'allow' });
  });

  it('observes without refusing when the document mode is observe', () => {
    const observing = { ...DEFAULT_COMMAND_POLICY, mode: 'observe' } as const;

    expect(evaluateCommandPolicy(bashRequest('rm -rf x'), observing)).toMatchObject({
      decision: 'allow', observed: { ruleId: 'no-forced-recursive-rm', reason: expect.any(String), alternative: expect.any(String) },
    });
  });
});

describe('rule scope', () => {
  const request = (overrides = {}) => bashRequest('rm x', overrides);

  it.each([
    ['tools', { tools: ['Write'] }, {}],
    ['harnesses', { harnesses: ['fake'] }, {}],
    ['actor', { actor: 'subagent' as const }, {}],
    ['presence', { presence: 'attended' as const }, {}],
    ['models', { models: ['opus'] }, { model: 'haiku' }],
  ])('skips a rule outside its %s', (_label, scope, requestOverrides) => {
    const policy = policyWith([aRule({ id: 'scoped', ...scope })]);

    expect(evaluateCommandPolicy(request(requestOverrides), policy).decision).toBe('allow');
  });

  it.each([
    ['tools', { tools: ['Bash'] }, {}],
    ['harnesses', { harnesses: ['claude-cli'] }, {}],
    ['actor', { actor: 'session' as const }, {}],
    ['presence', { presence: 'unattended' as const }, {}],
    ['models', { models: ['opus'] }, { model: 'claude-opus-5-5' }],
    ['any actor', { actor: 'any' as const }, { actor: 'subagent' as const }],
  ])('applies a rule inside its %s', (_label, scope, requestOverrides) => {
    const policy = policyWith([aRule({ id: 'scoped', ...scope })]);

    expect(evaluateCommandPolicy(request(requestOverrides), policy)).toMatchObject({ decision: 'deny', ruleId: 'scoped' });
  });
});

describe('rule predicates', () => {
  const denies = (when: PolicyRule['when'], command: string) =>
    evaluateCommandPolicy(bashRequest(command), policyWith([aRule({ id: 'p', when })])).decision === 'deny';

  it('matches the subcommand after git global options', () => {
    expect(denies({ program: 'git', subcommand: 'push' }, 'git -C sub -c user.name=x push origin')).toBe(true);
    expect(denies({ program: 'git', subcommand: 'push' }, 'git status push')).toBe(false);
    expect(denies({ program: 'git', subcommand: ['push', 'commit'] }, 'git commit -m x')).toBe(true);
  });

  it('matches flag groups in any order, short clusters and long names', () => {
    const when = { program: 'rm', flags: { all: [['r', 'recursive'], ['f', 'force']] } };

    expect(denies(when, 'rm -fr x')).toBe(true);
    expect(denies(when, 'rm --force -r x')).toBe(true);
    expect(denies(when, 'rm -r x')).toBe(false);
    expect(denies(when, 'rm x -rf')).toBe(true);
    expect(denies(when, 'rm -- -rf')).toBe(false);
  });

  it('matches any flag group and excludes none groups', () => {
    expect(denies({ program: 'ls', flags: { any: [['a'], ['l']] } }, 'ls -l')).toBe(true);
    expect(denies({ program: 'ls', flags: { any: [['a'], ['l']] } }, 'ls -h')).toBe(false);
    expect(denies({ program: 'ls', flags: { none: [['a']] } }, 'ls -la')).toBe(false);
  });

  it('matches a command prefix with alternative words', () => {
    const when = { commandPrefix: [['cargo', 'test|build']] };

    expect(denies(when, 'cargo build --release')).toBe(true);
    expect(denies(when, 'cargo run')).toBe(false);
    expect(denies(when, 'cargo')).toBe(false);
  });

  it('combines predicates with anyOf, allOf and not', () => {
    expect(denies({ anyOf: [{ program: 'rm' }, { program: 'mv' }] }, 'mv a b')).toBe(true);
    expect(denies({ allOf: [{ program: 'rm' }, { flags: { any: [['f']] } }] }, 'rm -f x')).toBe(true);
    expect(denies({ allOf: [{ program: 'rm' }, { flags: { any: [['f']] } }] }, 'rm x')).toBe(false);
    expect(denies({ not: { program: 'ls' } }, 'ls')).toBe(false);
    expect(denies({ program: 'rm', not: { flags: { any: [['f']] } } }, 'rm x')).toBe(true);
  });

  it('matches a written path with restricted globs', () => {
    const when = { writesPathMatching: ['**/secrets/*.env', 'dist/**'] };

    expect(denies(when, 'echo x > a/secrets/prod.env')).toBe(true);
    expect(denies(when, 'echo x > dist/deep/file.js')).toBe(true);
    expect(denies(when, 'echo x > a/secrets/deep/prod.env')).toBe(false);
    expect(denies(when, 'echo x > src/file.js')).toBe(false);
  });

  it('finds the recursive search without a path, with its quoting rules', () => {
    const repoWide = { repoWideSearch: true } as const;

    expect(denies(repoWide, 'grep -r foo')).toBe(true);
    expect(denies(repoWide, "grep -rE 'a|b'")).toBe(true);
    expect(denies(repoWide, 'rg foo')).toBe(true);
    expect(denies(repoWide, 'rg -e foo')).toBe(true);
    expect(denies(repoWide, 'rg foo src')).toBe(false);
    expect(denies(repoWide, 'rg -g "*.ts" foo src')).toBe(false);
    expect(denies(repoWide, 'grep foo')).toBe(false);
    expect(denies(repoWide, 'cat f | rg foo')).toBe(false);
    expect(denies(repoWide, 'grep -E foo src -r')).toBe(false);
  });
});

describe('the evaluation never fails the session', () => {
  it('allows a request that carries no command', () => {
    expect(evaluateCommandPolicy(policyRequest({ toolName: 'Bash' }), DEFAULT_COMMAND_POLICY).decision).toBe('allow');
    expect(evaluateCommandPolicy(policyRequest({ toolName: 'Bash', command: 7 as unknown as string }), DEFAULT_COMMAND_POLICY).decision).toBe('allow');
  });

  it('allows an unreadable command above the size limit and reports the degradation', () => {
    const verdict = evaluateCommandPolicy(bashRequest(`rm -rf ${'x'.repeat(70_000)}`), DEFAULT_COMMAND_POLICY);

    expect(verdict).toEqual({ decision: 'allow', degraded: 'limit_exceeded' });
  });

  it('skips a rule that cannot be evaluated and applies the others', () => {
    const broken = { ...aRule({ id: 'broken' }), when: { flags: null } } as unknown as PolicyRule;
    const policy = policyWith([broken, aRule({ id: 'healthy' })]);

    expect(evaluateCommandPolicy(bashRequest('rm x'), policy)).toMatchObject({ decision: 'deny', ruleId: 'healthy' });
  });

  it('ignores a profile entry that names an unknown rule', () => {
    const policy = policyWith([aRule({ id: 'healthy' })], { profiles: { default: { rules: ['ghost', 'healthy'] } } });

    expect(evaluateCommandPolicy(bashRequest('rm x'), policy)).toMatchObject({ decision: 'deny', ruleId: 'healthy' });
  });

  it('allows when the policy names no profile at all', () => {
    const policy = policyWith([aRule({ id: 'r' })], { profiles: {} });

    expect(evaluateCommandPolicy(bashRequest('rm x'), policy).decision).toBe('allow');
  });

  it('terminates on a profile that extends itself', () => {
    const policy = policyWith([aRule({ id: 'r' })], { profiles: { default: { extends: 'loop', rules: ['r'] }, loop: { extends: 'default', rules: [] } } });

    expect(evaluateCommandPolicy(bashRequest('rm x'), policy).decision).toBe('deny');
  });
});

describe('rule order', () => {
  it('lets the first refusing rule of the profile win', () => {
    const policy = policyWith([
      aRule({ id: 'second', when: { program: 'rm' }, reason: 'second' }),
      aRule({ id: 'first', when: { program: 'rm' }, reason: 'first' }),
    ], { profiles: { default: { rules: ['first', 'second'] } } });

    expect(evaluateCommandPolicy(bashRequest('rm x'), policy)).toMatchObject({ ruleId: 'first' });
  });

  it('does not let an allow rule end the evaluation', () => {
    const policy = policyWith([
      aRule({ id: 'permit', decision: 'allow', when: { program: 'rm' }, alternative: undefined }),
      aRule({ id: 'refuse' }),
    ]);

    expect(evaluateCommandPolicy(bashRequest('rm x'), policy)).toMatchObject({ decision: 'deny', ruleId: 'refuse' });
  });

  it('returns an ask verdict without an alternative', () => {
    const policy = policyWith([aRule({ id: 'confirm', decision: 'ask', alternative: undefined })]);

    expect(evaluateCommandPolicy(bashRequest('rm x'), policy)).toEqual({ decision: 'ask', ruleId: 'confirm', reason: 'rm is refused.' });
  });

  it('returns the same verdict for the same request', () => {
    const request = bashRequest("sh -c 'rm -rf x; git clean -fd'");

    expect(evaluateCommandPolicy(request, DEFAULT_COMMAND_POLICY)).toEqual(evaluateCommandPolicy(request, DEFAULT_COMMAND_POLICY));
  });
});

describe('evaluation cost', () => {
  const LENIENT_BOUND_MS = 20;
  const SAMPLES = 21;

  const twoKiloByteCommand = (): string => {
    const unit = `cd "app dir" && echo 'a|b;c' | grep -v "x && y" > out.txt; sh -c 'ls -la $(pwd)' && `;
    return `${unit.repeat(Math.ceil(2048 / unit.length))}git status`.slice(0, 2048);
  };

  it('evaluates a 2 KiB command in under 20 ms (median of 21 runs, a bound about twenty times the observed cost)', () => {
    const request = bashRequest(twoKiloByteCommand(), { role: 'DEV', model: 'opus' });
    evaluateCommandPolicy(request, DEFAULT_COMMAND_POLICY);

    const durations = Array.from({ length: SAMPLES }, () => {
      const startedAt = performance.now();
      evaluateCommandPolicy(request, DEFAULT_COMMAND_POLICY);
      return performance.now() - startedAt;
    }).sort((a, b) => a - b);

    expect(request.command).toHaveLength(2048);
    expect(durations[Math.floor(SAMPLES / 2)]).toBeLessThan(LENIENT_BOUND_MS);
  });
});
