import { describe, expect, it } from 'vitest';
import type { DetectedRepository } from '@openfleet/shared';
import { ALLOW_DECLARED_COMMANDS_RULE_ID, DEFAULT_COMMAND_POLICY } from './defaultCommandPolicy.js';
import { declaredCommandsFrom } from './declaredCommands.js';
import { ruleIdsOfProfile } from './policyEvaluator.js';
import { resolveCommandPolicy, validateCommandPolicyOverride, validPartsOfOverride } from './policyDocument.js';

const overrideDeclaring = (declaredCommands: unknown) => ({ version: 1, declaredCommands });
const declaredListOf = (policy: ReturnType<typeof resolveCommandPolicy>['policy']) =>
  policy.rules.find((rule) => rule.id === ALLOW_DECLARED_COMMANDS_RULE_ID)?.when.runsDeclaredCommand;

describe('the declaredCommands setting', () => {
  it('is empty in the delivered policy, so the allow rule is inert', () => {
    const rule = DEFAULT_COMMAND_POLICY.rules.find(({ id }) => id === ALLOW_DECLARED_COMMANDS_RULE_ID);

    expect(rule?.when.runsDeclaredCommand).toEqual([]);
  });

  it('fills the list of the allow rule and keeps the rest of the policy', () => {
    const { policy, issues } = resolveCommandPolicy({ delivered: DEFAULT_COMMAND_POLICY, override: overrideDeclaring(['pytest', 'pnpm test']) });

    expect(issues).toEqual([]);
    expect(declaredListOf(policy)).toEqual(['pytest', 'pnpm test']);
    expect(policy.rules).toHaveLength(DEFAULT_COMMAND_POLICY.rules.length);
  });

  it('applies to the dev and qe profiles only', () => {
    const profilesCarrying = Object.keys(DEFAULT_COMMAND_POLICY.profiles).filter((name) => ruleIdsOfProfile(DEFAULT_COMMAND_POLICY.profiles, name).includes(ALLOW_DECLARED_COMMANDS_RULE_ID));

    expect(profilesCarrying.sort()).toEqual(['dev', 'qe']);
  });

  it.each([
    ['a shell', 'sh'],
    ['a shell with a script', 'bash run.sh'],
    ['env', 'env pytest'],
    ['an interpreter', 'python -m pytest'],
    ['node', 'node script.js'],
    ['a network tool', 'curl example.invalid'],
    ['git', 'git status'],
    ['find', 'find . -name x'],
    ['xargs', 'xargs pytest'],
    ['pnpm exec of anything', 'pnpm exec sh'],
    ['pnpm dlx', 'pnpm dlx evil'],
    ['uv run of an interpreter', 'uv run python'],
    ['cargo build', 'cargo build'],
    ['a publishing script', 'npm run publish'],
    ['a deploy script', 'yarn run deploy'],
    ['an arbitrary pnpm script', 'pnpm run x'],
    ['a build script', 'pnpm run build'],
    ['a makefile chosen by option', 'make -f /tmp/x test'],
    ['an argument file', 'pytest @x'],
    ['a formatter that rewrites files', 'ruff format .'],
    ['the useless uv launcher form', 'uv run pytest'],
  ])('refuses to declare %s, in a save and in the file at boot', (_label, entry) => {
    const refused = overrideDeclaring([entry]);

    expect(validateCommandPolicyOverride(refused).ok).toBe(false);
    const { issues, policy } = resolveCommandPolicy({ delivered: DEFAULT_COMMAND_POLICY, override: refused });
    expect(issues).toEqual([expect.objectContaining({ scope: 'field', field: 'declaredCommands' })]);
    expect(declaredListOf(policy)).toEqual([]);
  });

  it.each(['pytest', 'ruff check .', 'mypy .', 'pnpm test', 'pnpm run lint', 'npm run test', 'yarn test', 'vitest', 'jest', 'tsc --noEmit', 'eslint .', 'cargo test', 'cargo clippy', 'go test ./...', 'go vet ./...', 'make test', 'npm run lint', 'yarn run type-check', 'pnpm run test'])(
    'accepts to declare the known runner %j',
    (entry) => {
      expect(validateCommandPolicyOverride(overrideDeclaring([entry]))).toMatchObject({ ok: true });
    },
  );

  it('shows the rule as delivered while the declared list is empty', () => {
    const { policy } = resolveCommandPolicy({ delivered: DEFAULT_COMMAND_POLICY, override: overrideDeclaring([]) });

    const rule = policy.rules.find(({ id }) => id === ALLOW_DECLARED_COMMANDS_RULE_ID);
    expect(rule).toBe(DEFAULT_COMMAND_POLICY.rules.find(({ id }) => id === ALLOW_DECLARED_COMMANDS_RULE_ID));
  });

  it('is kept by the valid parts of the override, so saving it back is accepted', () => {
    const saved = overrideDeclaring(['pytest']);

    expect(validPartsOfOverride({ delivered: DEFAULT_COMMAND_POLICY, override: saved })).toEqual(saved);
  });

  it('is accepted by the strict validation of a save', () => {
    expect(validateCommandPolicyOverride(overrideDeclaring(['ruff check .', 'pnpm run type:check']))).toMatchObject({ ok: true });
  });

  it.each([
    ['a semicolon', 'pytest; rm x'],
    ['an and-list', 'pytest && id'],
    ['an or-list', 'pytest || id'],
    ['a pipe', 'pytest | sh'],
    ['a dollar sign', 'pytest $HOME'],
    ['a command substitution', 'pytest $(id)'],
    ['a backtick', 'pytest `id`'],
    ['an output redirection', 'pytest > out.txt'],
    ['an input redirection', 'pytest < in.txt'],
    ['a newline', 'pytest\nrm x'],
    ['a background ampersand', 'pytest &'],
    ['an empty entry', ''],
    ['an entry that starts with a dash', '-rf'],
  ])('refuses a declared command with %s, in a save and in the file at boot', (_label, entry) => {
    const refused = overrideDeclaring([entry]);

    expect(validateCommandPolicyOverride(refused).ok).toBe(false);
    const { issues, policy } = resolveCommandPolicy({ delivered: DEFAULT_COMMAND_POLICY, override: refused });
    expect(issues).toEqual([expect.objectContaining({ scope: 'field', field: 'declaredCommands' })]);
    expect(declaredListOf(policy)).toEqual([]);
  });

  it('refuses a list that is not a list of strings', () => {
    expect(validateCommandPolicyOverride(overrideDeclaring('pytest')).ok).toBe(false);
    expect(validateCommandPolicyOverride(overrideDeclaring([1])).ok).toBe(false);
  });
});

describe('declaredCommandsFrom: the commands a project declares from its detection', () => {
  const detected = (commands: DetectedRepository['commands']): DetectedRepository['commands'] => commands;

  it('keeps the test, lint and typecheck commands, and leaves out install, build and dev', () => {
    const commands = detected({
      install: { command: 'pnpm install', source: 'package.json' },
      build: { command: 'pnpm run build', source: 'package.json' },
      dev: { command: 'pnpm run dev', source: 'package.json' },
      test: { command: 'pnpm test', source: 'package.json' },
      lint: { command: 'pnpm run lint', source: 'package.json' },
      typecheck: { command: 'pnpm run type:check', source: 'package.json' },
    });

    expect(declaredCommandsFrom(commands)).toEqual(['pnpm test', 'pnpm run lint', 'pnpm run type:check']);
  });

  it('names the pytest, ruff and mypy commands of a pyproject', () => {
    const commands = detected({
      test: { command: 'pytest', source: 'pyproject.toml' },
      lint: { command: 'ruff check .', source: 'pyproject.toml' },
      typecheck: { command: 'mypy .', source: 'pyproject.toml' },
    });

    expect(declaredCommandsFrom(commands)).toEqual(['pytest', 'ruff check .', 'mypy .']);
  });

  it('leaves out an interpreter or a network tool that detection names as a command', () => {
    const commands = detected({
      test: { command: 'sh', source: 'package.json' },
      lint: { command: 'curl example.invalid', source: 'package.json' },
      typecheck: { command: 'mypy .', source: 'pyproject.toml' },
    });

    expect(declaredCommandsFrom(commands)).toEqual(['mypy .']);
  });

  it('declares nothing for a repository without detected commands', () => {
    expect(declaredCommandsFrom({})).toEqual([]);
  });
});
