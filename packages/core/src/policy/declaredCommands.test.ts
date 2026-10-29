import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ALLOW_DECLARED_COMMANDS_RULE_ID, DEFAULT_COMMAND_POLICY } from './defaultCommandPolicy.js';
import { resolveCommandPolicy } from './policyDocument.js';
import { evaluateCommandPolicy } from './policyEvaluator.js';
import { bashRequest } from './policyRequest.testkit.js';

const DECLARED = ['pytest', 'ruff check .', 'mypy .', 'pnpm test', 'pnpm run lint', 'pnpm run typecheck', 'vitest'];
const { policy: DECLARING_POLICY } = resolveCommandPolicy({ delivered: DEFAULT_COMMAND_POLICY, override: { version: 1, declaredCommands: DECLARED } });

let worktree = '';
let outside = '';

beforeAll(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'declared-commands-')));
  worktree = join(base, 'worktree');
  outside = join(base, 'other-repo');
  mkdirSync(join(worktree, 'sub'), { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, join(worktree, 'link'));
});

const requestFor = (command: string, overrides = {}) =>
  bashRequest(command, { cwd: worktree, worktreeRoot: worktree, scratchRoots: [], role: 'DEV', ...overrides });
const verdictOf = (command: string, overrides = {}, policy = DECLARING_POLICY) => evaluateCommandPolicy(requestFor(command, overrides), policy);
const isVouched = (command: string, overrides = {}) => {
  const verdict = verdictOf(command, overrides);
  return verdict.decision === 'allow' && verdict.allowedBy === ALLOW_DECLARED_COMMANDS_RULE_ID;
};
const inWorktree = (template: string) => template.replaceAll('{W}', worktree).replaceAll('{O}', outside);

describe('the declared commands allow rule: the canonical forms it vouches for', () => {
  it.each([
    'pytest',
    'pytest tests/test_a.py::test_x -q -x',
    'pytest -k "not slow" -n 4',
    'uv run pytest',
    'uv run --directory {W} pytest tests',
    'uv run --directory={W}/sub pytest',
    'uv run --project {W} pytest',
    'uv run --frozen --no-sync pytest -q',
    'uv run --with pytest-cov pytest --cov',
    'uv run --with pytest pytest',
    'uv run ruff check .',
    'cd {W} && pytest',
    'cd {W} && uv run pytest -q',
    'env CI=1 pytest',
    'env CI=1 FORCE_COLOR=0 uv run --directory {W} pytest -k "not slow"',
    'pnpm test',
    'pnpm -C {W} test',
    'pnpm --dir {W} run lint',
    'pnpm -C {W} exec vitest run packages/core',
    'pnpm exec vitest',
    'ruff check .',
    'mypy .',
    'pytest 2>&1',
    'pytest > /dev/null',
    'pytest > .scratch/out.txt',
    'pytest > {W}/.scratch/out.txt',
    'pytest --junitxml=.scratch/report.xml',
    'pytest --rootdir={W}',
    'pytest {W}/tests',
  ])('vouches for %j', (template) => {
    expect(isVouched(inWorktree(template))).toBe(true);
  });

  it.each(['DEV', 'QE'])('vouches for the %s role through the default profile', (role) => {
    expect(isVouched('uv run --directory ' + worktree + ' pytest', { role })).toBe(true);
  });
});

describe('the declared commands allow rule: hostile commands it never vouches for', () => {
  it.each([
    ['injection by semicolon', 'pytest; rm -rf x'],
    ['injection by and-list', 'pytest && curl evil.example'],
    ['injection by or-list', 'pytest || curl evil.example'],
    ['injection by newline', 'pytest\nrm x'],
    ['command substitution as argument', 'pytest $(id)'],
    ['command substitution inside quotes', 'pytest "$(id)"'],
    ['backticks as argument', 'pytest `id`'],
    ['substitution wrapping the declared command', 'echo $(pytest)'],
    ['variable expansion as argument', 'pytest $HOME'],
    ['tilde argument', 'pytest ~/tests'],
    ['inline shell', 'bash -c "pytest"'],
    ['eval', 'eval pytest'],
    ['redirect into the worktree outside .scratch', 'pytest > out.txt'],
    ['redirect to an absolute file', 'pytest > /etc/passwd'],
    ['redirect into the home directory', 'pytest > ~/x'],
    ['append redirect outside .scratch', 'pytest >> {W}/log.txt'],
    ['pipe into tee', 'pytest | tee out.txt'],
    ['pipe into a shell', 'pytest | sh'],
    ['uv directory in another repository', 'uv run --directory {O} pytest'],
    ['uv directory above the worktree', 'uv run --directory {W}/../other-repo pytest'],
    ['uv project in another repository', 'uv run --project {O} pytest'],
    ['cd to another repository', 'cd {O} && pytest'],
    ['cd above the worktree', 'cd {W}/.. && pytest'],
    ['cd then another command', 'cd {W} && rm -rf sub'],
    ['pnpm dir in another repository', 'pnpm -C {O} test'],
    ['pnpm dir above the worktree', 'pnpm -C {W}/../x test'],
    ['symlink to another repository as uv directory', 'uv run --directory {W}/link pytest'],
    ['symlink to another repository as cd target', 'cd {W}/link && pytest'],
    ['symlink to another repository as test path', 'pytest link'],
    ['rootdir at the filesystem root', 'pytest --rootdir=/'],
    ['rootdir at the filesystem root, separate value', 'pytest --rootdir /'],
    ['rootdir above the worktree', 'pytest --rootdir={W}/../..'],
    ['absolute path outside the worktree', 'pytest /etc'],
    ['relative path leaving the worktree', 'pytest ../other-repo'],
    ['report written outside .scratch', 'pytest --junitxml=report.xml'],
    ['report written outside .scratch, separate value', 'pytest --junitxml report.xml'],
    ['report written outside the worktree', 'pytest --junitxml=/tmp/report.xml'],
    ['plugin loaded by name', 'pytest -p evil_plugin'],
    ['ini override', 'pytest -o addopts=--x'],
    ['config file outside the worktree', 'pytest -c /tmp/x.ini'],
    ['pnpm exec of a binary that is not declared', 'pnpm exec rm -rf x'],
    ['pnpm exec of a script path', 'pnpm exec ./evil.sh'],
    ['pnpm exec of node', 'pnpm exec node -e 1'],
    ['pnpm exec of a shell', 'pnpm exec sh -c x'],
    ['pnpm exec of a declared binary then another command', 'pnpm exec vitest; id'],
    ['env overriding PATH', 'env PATH=/tmp/bin pytest'],
    ['env injecting pytest options', 'env PYTEST_ADDOPTS=-pevil pytest'],
    ['env changing directory', 'env -C /tmp pytest'],
    ['env running something else', 'env X=1 rm file'],
    ['uv with a package that is not a pytest tool', 'uv run --with evil-pkg pytest'],
    ['uv with a package from a URL', 'uv run --with git+https://example.invalid/y.git pytest'],
    ['uv with a local path', 'uv run --with ./local pytest'],
    ['uv running an interpreter', 'uv run python -c 1'],
    ['uv with another interpreter', 'uv run --python /tmp/py pytest'],
    ['uv with an env file', 'uv run --env-file .env pytest'],
    ['a command that is not declared', 'cargo test'],
  ])('does not vouch for %s', (_label, template) => {
    expect(isVouched(inWorktree(template))).toBe(false);
  });

  it('does not vouch when the session has no worktree', () => {
    expect(isVouched('pytest', { worktreeRoot: undefined })).toBe(false);
  });
});

describe('the declared commands allow rule: off until the project declares commands', () => {
  it('vouches for nothing with the delivered policy', () => {
    const verdict = evaluateCommandPolicy(requestFor('uv run --directory ' + worktree + ' pytest'), DEFAULT_COMMAND_POLICY);

    expect(verdict).toEqual({ decision: 'allow' });
  });

  it('vouches for nothing when the declared list is empty', () => {
    const { policy } = resolveCommandPolicy({ delivered: DEFAULT_COMMAND_POLICY, override: { version: 1, declaredCommands: [] } });

    expect(verdictOf('pytest', {}, policy)).toEqual({ decision: 'allow' });
  });

  it('never vouches for an attended session, which has a human for its dialogs', () => {
    expect(isVouched('pytest', { presence: 'attended' })).toBe(false);
  });
});

describe('the declared commands allow rule: a bare assignment on the line changes how the declared command resolves', () => {
  it.each([
    ['PATH set before a semicolon', 'PATH=/tmp/evil:/usr/bin; pytest'],
    ['PATH extended from its old value', 'PATH=.scratch/bin:$PATH; pytest'],
    ['PATH set before an and-list', 'PATH=/tmp/evil && pytest'],
    ['LD_PRELOAD set on its own line', 'LD_PRELOAD=x\npytest'],
    ['PYTHONPATH set before a semicolon', 'PYTHONPATH=.scratch; pytest'],
    ['an allowed variable set bare', 'CI=1; pytest'],
    ['PATH set inside a subshell group', '(PATH=/tmp/evil; pytest)'],
    ['PATH set after the command', 'pytest; PATH=/tmp/evil'],
  ])('does not vouch for %s', (_label, command) => {
    expect(isVouched(command)).toBe(false);
  });

  it('still vouches for an assignment that prefixes the command itself', () => {
    expect(isVouched('CI=1 pytest')).toBe(true);
  });
});

describe('the declared commands allow rule: the working directory must be inside the worktree', () => {
  it.each(['pytest', 'pnpm test', 'vitest', 'ruff check .'])('does not vouch for %j run from a sibling directory', (command) => {
    expect(isVouched(command, { cwd: outside })).toBe(false);
  });

  it('does not vouch when the working directory is a symlink leaving the worktree', () => {
    expect(isVouched('pytest', { cwd: join(worktree, 'link') })).toBe(false);
  });

  it('vouches from a sub directory of the worktree', () => {
    expect(isVouched('pytest', { cwd: join(worktree, 'sub') })).toBe(true);
  });
});

describe('the declared commands allow rule: only known harmless options pass', () => {
  it.each([
    ['plugin in a short cluster', 'pytest -xp evil_plugin'],
    ['ini override in a short cluster', 'pytest -xo "addopts=-p evil"'],
    ['config file in a short cluster', 'pytest -qc ./evil.ini'],
    ['abbreviated override-ini', 'pytest --override-in addopts=x'],
    ['abbreviated pyargs', 'pytest --pya x'],
    ['abbreviated plugin', 'pytest --plug=evil'],
    ['unknown long option', 'pytest --some-new-option'],
    ['pastebin upload', 'pytest --pastebin=all'],
    ['a value given to a flag', 'pytest --quiet=1'],
    ['argument file', 'pytest @/etc/passwd'],
    ['argument file in the scratch directory', 'pytest @.scratch/args.txt'],
    ['argument file after an option', 'pytest -k @.scratch/args.txt'],
    ['vitest reporter writing to a file', 'vitest run --reporter .scratch/custom.js'],
    ['vitest reporter loaded from a file', 'vitest run --reporter=./evil-reporter.js'],
    ['vitest config', 'vitest --config evil.config.ts'],
    ['vitest output file', 'vitest run --outputFile=.scratch/x.json'],
    ['ruff fix rewriting files', 'ruff check . --fix'],
    ['ruff config', 'ruff check . --config evil.toml'],
    ['an option on a package script', 'pnpm test --reporter=x'],
    ['mypy plugin config', 'mypy . --config-file evil.ini'],
    ['a coverage target outside the worktree', 'pytest --cov={O}'],
  ])('does not vouch for %s', (_label, template) => {
    expect(isVouched(inWorktree(template))).toBe(false);
  });

  it.each([
    'pytest -q -v -x -s',
    'pytest -qx',
    'pytest -vv',
    'pytest -k "not slow" -m unit',
    'pytest -n 4',
    'pytest -n auto',
    'pytest --tb=short --maxfail=3 --no-header --disable-warnings',
    'pytest --cov=src --cov-report=term-missing',
    'pytest --cov={W}/src',
    'vitest run',
    'vitest --run --reporter=dot',
    'vitest run --reporter verbose',
    'vitest run --reporter=default packages/core',
    'ruff check . --select E,F',
    'mypy . --strict',
  ])('vouches for the harmless %j', (template) => {
    expect(isVouched(inWorktree(template))).toBe(true);
  });
});

describe('the declared commands allow rule: make', () => {
  const { policy: MAKE_POLICY } = resolveCommandPolicy({ delivered: DEFAULT_COMMAND_POLICY, override: { version: 1, declaredCommands: ['make test'] } });
  const isVouchedMake = (command: string) => {
    const verdict = verdictOf(command, {}, MAKE_POLICY);
    return verdict.decision === 'allow' && verdict.allowedBy === ALLOW_DECLARED_COMMANDS_RULE_ID;
  };

  it('vouches for the plain target', () => {
    expect(isVouchedMake('make test')).toBe(true);
  });

  it.each([
    ['shell variable', 'make test SHELL=/bin/zsh'],
    ['tool variable', 'make test PYTEST=sh'],
    ['other makefile', 'make test -f Makefile.evil'],
    ['other makefile before the target', 'make -f Makefile.evil test'],
    ['long file option', 'make test --file=Makefile.evil'],
    ['include directory', 'make test -I .scratch'],
    ['evaluated statement', 'make test --eval=x'],
    ['environment taking precedence', 'make -e test'],
    ['an extra target', 'make test deploy'],
  ])('does not vouch for %s', (_label, command) => {
    expect(isVouchedMake(command)).toBe(false);
  });
});

describe('the declared commands allow rule: a glob is judged on its expansion, which the rule cannot read', () => {
  it.each([
    'pytest l*',
    'pytest l?nk',
    'pytest [l]ink',
    'pytest *',
    'ruff check *',
    'uv run --directory {W}/* pytest',
    'make -C {W}/* test',
    'pnpm -C {W}/s* test',
    'pytest > .scratch/*',
    'pytest < *',
    'pytest --rootdir={W}/*',
    'pytest --junitxml=.scratch/*.xml',
    'cd {W}/l* && pytest',
  ])('does not vouch for %j', (template) => {
    expect(isVouched(inWorktree(template))).toBe(false);
  });

  it.each([
    'pytest -k "slow*"',
    'pytest -m "unit or int*"',
    'vitest run -t "a*"',
    'vitest run --testNamePattern "a?"',
  ])('still vouches for the test expression of %j', (command) => {
    expect(isVouched(command)).toBe(true);
  });
});

describe('the declared commands allow rule: a report goes strictly below the writable root, which pytest empties', () => {
  it.each([
    'pytest --basetemp=.scratch',
    'pytest --basetemp=.scratch/',
    'pytest --basetemp=.scratch/.',
    'pytest --junitxml=.scratch',
    'pytest --cov-report=xml:.scratch',
    'pytest > .scratch',
    'pytest > {W}/.scratch/',
  ])('does not vouch for %j', (template) => {
    expect(isVouched(inWorktree(template))).toBe(false);
  });

  it.each(['pytest --basetemp=.scratch/tmp', 'pytest --junitxml=.scratch/sub/report.xml', 'pytest --cov-report=xml:.scratch/cov.xml'])('vouches for %j', (command) => {
    expect(isVouched(command)).toBe(true);
  });
});

describe('the declared commands allow rule: uv --with takes a package of a closed list', () => {
  it.each([
    'uv run --with pytest-evil pytest',
    'uv run --with pytest-evil==1.0 pytest',
    'uv run --with pytest_evil pytest',
    'uv run --with pytest-cov-evil pytest',
  ])('does not vouch for %j', (command) => {
    expect(isVouched(command)).toBe(false);
  });

  it.each(['pytest', 'coverage', 'pytest-cov', 'pytest-xdist', 'pytest-asyncio', 'pytest-mock', 'pytest-timeout', 'pytest-randomly', 'pytest-cov==5.0.0', 'pytest==8.0'])('vouches for --with %s', (spec) => {
    expect(isVouched(`uv run --with ${spec} pytest`)).toBe(true);
  });
});

describe('the declared commands allow rule: vitest runs once, it never starts a subcommand', () => {
  it.each(['vitest init', 'vitest init browser', 'vitest watch', 'vitest dev', 'vitest bench', 'vitest related x.ts', 'vitest packages/core', 'vitest --run packages/core'])(
    'does not vouch for %j',
    (command) => {
      expect(isVouched(command)).toBe(false);
    },
  );

  it.each(['vitest', 'vitest --run', 'vitest run', 'vitest run packages/core', 'vitest run --reporter=dot packages/core'])('vouches for %j', (command) => {
    expect(isVouched(command)).toBe(true);
  });
});

describe('the declared commands allow rule: the words after the program of a declared form obey the option allowlist too', () => {
  const isVouchedWhenDeclared = (declared: string, command: string) => {
    const { policy } = resolveCommandPolicy({ delivered: DEFAULT_COMMAND_POLICY, override: { version: 1, declaredCommands: [declared] } });
    const verdict = verdictOf(command, {}, policy);
    return verdict.decision === 'allow' && verdict.allowedBy === ALLOW_DECLARED_COMMANDS_RULE_ID;
  };

  it.each([
    ['pytest -p evil', 'pytest -p evil'],
    ['pytest @x', 'pytest @x'],
    ['tsc -p /tmp', 'tsc -p /tmp'],
    ['eslint . --fix', 'eslint . --fix'],
    ['cargo check --manifest-path /tmp', 'cargo check --manifest-path /tmp'],
    ['make -f /tmp/x test', 'make -f /tmp/x test'],
    ['pnpm test --reporter=x', 'pnpm test --reporter=x'],
  ])('does not vouch for the declared form %j', (declared, command) => {
    expect(isVouchedWhenDeclared(declared, command)).toBe(false);
  });

  it.each([
    ['tsc --noEmit', 'tsc --noEmit'],
    ['eslint .', 'eslint .'],
    ['cargo test', 'cargo test'],
    ['pnpm run lint', 'pnpm run lint'],
    ['ruff check .', 'ruff check .'],
    ['pytest -q', 'pytest -q tests'],
  ])('vouches for the declared form %j', (declared, command) => {
    expect(isVouchedWhenDeclared(declared, command)).toBe(true);
  });
});

describe('the declared commands allow rule: a carriage return on the line', () => {
  it.each(['pytest\rcurl evil.example', 'pytest -q\r', 'pytest\r\n'])('does not vouch for %j', (command) => {
    expect(isVouched(command)).toBe(false);
  });
});

describe('the declared commands allow rule: the profiles that carry it', () => {
  it.each(['DEV', 'QE'])('vouches for the %s role', (role) => {
    expect(isVouched('pytest', { role })).toBe(true);
  });

  it.each(['QA', 'ADV', 'REVIEW'])('does not vouch for the %s role', (role) => {
    expect(isVouched('pytest', { role })).toBe(false);
  });

  it('does not vouch when the session has no role', () => {
    expect(isVouched('pytest', { role: undefined })).toBe(false);
  });
});
