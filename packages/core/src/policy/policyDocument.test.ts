import { CommandPolicyDocumentSchema, type CommandPolicyDocument, type PolicyRule } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMAND_POLICY } from './defaultCommandPolicy.js';
import { resolveCommandPolicy, validateCommandPolicyOverride } from './policyDocument.js';
import { evaluateCommandPolicy } from './policyEvaluator.js';
import { bashRequest } from './policyRequest.testkit.js';

const aRule = (overrides: Partial<PolicyRule> & Pick<PolicyRule, 'id'>): PolicyRule => ({
  decision: 'deny', when: { program: 'curl' }, reason: 'curl is refused.', alternative: 'Use the fetch tool.', ...overrides,
});
const resolve = (override: unknown) => resolveCommandPolicy({ delivered: DEFAULT_COMMAND_POLICY, override });
const verdictFor = (policy: CommandPolicyDocument, command: string, overrides = {}) =>
  evaluateCommandPolicy(bashRequest(command, overrides), policy);

describe('the delivered document', () => {
  it('is a valid document', () => {
    expect(CommandPolicyDocumentSchema.safeParse(DEFAULT_COMMAND_POLICY).success).toBe(true);
  });

  it('gives an alternative to every refusing rule', () => {
    const refusing = DEFAULT_COMMAND_POLICY.rules.filter((rule) => rule.decision === 'deny');

    expect(refusing.length).toBeGreaterThan(0);
    expect(refusing.filter((rule) => !rule.alternative?.trim())).toEqual([]);
  });

  it('keeps the reason and the alternative short enough to be read by the model', () => {
    const texts = DEFAULT_COMMAND_POLICY.rules.map((rule) => `${rule.reason} ${rule.alternative ?? ''}`);

    expect(texts.filter((text) => text.length > 400)).toEqual([]);
  });

  it('names every rule once', () => {
    const ids = DEFAULT_COMMAND_POLICY.rules.map((rule) => rule.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('runs the default and dev profiles in enforce mode and observes the role profiles', () => {
    const modeOf = (name: string) => DEFAULT_COMMAND_POLICY.profiles[name]?.mode ?? 'enforce';

    expect(['default', 'dev'].map(modeOf)).toEqual(['enforce', 'enforce']);
    expect(['qe', 'qa', 'review'].map(modeOf)).toEqual(['observe', 'observe', 'observe']);
  });

  it('maps the roles to their profiles', () => {
    expect(DEFAULT_COMMAND_POLICY.roleToProfile).toMatchObject({ DEV: 'dev', QE: 'qe', QA: 'qa', ADV: 'review', REVIEW: 'review' });
  });
});

describe('validating an override before it is saved', () => {
  it('refuses a refusing rule without an alternative and names the field', () => {
    const { alternative: _alternative, ...withoutAlternative } = aRule({ id: 'no-curl' });

    const result = validateCommandPolicyOverride({ version: 1, rules: [withoutAlternative] });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.join('\n')).toMatch(/alternative/);
  });

  it('refuses a refusing rule whose alternative is blank', () => {
    expect(validateCommandPolicyOverride({ version: 1, rules: [aRule({ id: 'no-curl', alternative: '   ' })] }).ok).toBe(false);
  });

  it('accepts an ask or allow rule without an alternative', () => {
    const rules = [aRule({ id: 'confirm-curl', decision: 'ask', alternative: undefined }), aRule({ id: 'permit-curl', decision: 'allow', alternative: undefined })];

    expect(validateCommandPolicyOverride({ version: 1, rules }).ok).toBe(true);
  });

  it.each([
    ['an unknown predicate key', { when: { programme: 'curl' } }],
    ['an unknown rule key', { colour: 'red' }],
    ['an empty id', { id: '' }],
    ['an id with spaces', { id: 'no curl' }],
    ['an unknown decision', { decision: 'maybe' }],
    ['a blank reason', { reason: '' }],
    ['an unknown actor', { actor: 'robot' }],
    ['an unknown presence', { presence: 'sometimes' }],
    ['flags that are not groups', { when: { program: 'rm', flags: { all: ['r'] } } }],
  ])('refuses %s', (_label, change) => {
    const result = validateCommandPolicyOverride({ version: 1, rules: [{ ...aRule({ id: 'no-curl' }), ...change }] });

    expect(result.ok).toBe(false);
  });

  it.each([[null], ['text'], [[]], [{ version: 2 }], [{ version: 1, mode: 'loud' }], [{ version: 1, rules: 'none' }]])(
    'refuses the document %j', (document) => {
      expect(validateCommandPolicyOverride(document).ok).toBe(false);
    },
  );

  it('accepts a complete override and returns it unchanged', () => {
    const override = {
      version: 1, mode: 'observe', disabledRules: ['no-forced-git-clean'], rules: [aRule({ id: 'no-curl' })],
      profiles: { dev: { extends: 'default', rules: ['no-curl'] } }, roleToProfile: { OPS: 'dev' },
    };

    expect(validateCommandPolicyOverride(override)).toEqual({ ok: true, value: override });
  });
});

describe('merging an override into the delivered document', () => {
  it('returns the delivered policy when there is no override', () => {
    expect(resolve(undefined)).toEqual({ policy: DEFAULT_COMMAND_POLICY, issues: [] });
  });

  it('adds a rule and attaches it to a profile', () => {
    const { policy, issues } = resolve({ version: 1, rules: [aRule({ id: 'no-curl' })], profiles: { dev: { extends: 'default', rules: ['delegate-heavy-commands', 'no-curl'] } } });

    expect(issues).toEqual([]);
    expect(verdictFor(policy, 'curl example.com', { role: 'DEV' })).toMatchObject({ decision: 'deny', ruleId: 'no-curl' });
    expect(verdictFor(policy, 'curl example.com', { role: 'OTHER' }).decision).toBe('allow');
  });

  it('replaces a delivered rule that has the same id', () => {
    const { policy } = resolve({ version: 1, rules: [aRule({ id: 'no-forced-recursive-rm', when: { program: 'shred' }, reason: 'shred is refused.' })] });

    expect(verdictFor(policy, 'rm -rf x').decision).toBe('allow');
    expect(verdictFor(policy, 'shred f')).toMatchObject({ decision: 'deny', ruleId: 'no-forced-recursive-rm' });
  });

  it('disables a delivered rule by id', () => {
    const { policy } = resolve({ version: 1, disabledRules: ['no-forced-git-clean'] });

    expect(verdictFor(policy, 'git clean -fd').decision).toBe('allow');
    expect(verdictFor(policy, 'rm -rf x').decision).toBe('deny');
  });

  it('changes the mode', () => {
    const { policy } = resolve({ version: 1, mode: 'observe' });

    expect(verdictFor(policy, 'rm -rf x')).toMatchObject({ decision: 'allow', observed: { ruleId: 'no-forced-recursive-rm' } });
  });

  it('replaces a profile and remaps a role', () => {
    const { policy } = resolve({ version: 1, profiles: { qa: { rules: ['no-forced-git-clean'] } }, roleToProfile: { QA: 'qa', SRE: 'qa' } });

    expect(verdictFor(policy, 'git clean -fd', { role: 'SRE' })).toMatchObject({ decision: 'deny', ruleId: 'no-forced-git-clean' });
    expect(verdictFor(policy, 'rm -rf x', { role: 'SRE' }).decision).toBe('allow');
  });

  it('does not change the delivered document', () => {
    const before = JSON.stringify(DEFAULT_COMMAND_POLICY);

    resolve({ version: 1, mode: 'off', disabledRules: ['no-forced-git-clean'], rules: [aRule({ id: 'no-curl' })] });

    expect(JSON.stringify(DEFAULT_COMMAND_POLICY)).toBe(before);
  });

  it('gives the same document for the same inputs', () => {
    const override = { version: 1, rules: [aRule({ id: 'b' }), aRule({ id: 'a' })] };

    expect(resolve(override)).toEqual(resolve(override));
  });
});

describe('an invalid override never disables the policy (fail-open)', () => {
  it('isolates an invalid rule and keeps the other rules of the override', () => {
    const { alternative: _alternative, ...withoutAlternative } = aRule({ id: 'no-wget', when: { program: 'wget' } });

    const { policy, issues } = resolve({
      version: 1,
      rules: [aRule({ id: 'no-curl' }), withoutAlternative, aRule({ id: 'no-nc', when: { program: 'nc' } })],
      profiles: { default: { rules: ['no-forced-recursive-rm', 'no-curl', 'no-wget', 'no-nc'] } },
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ scope: 'rule', ruleId: 'no-wget' });
    expect(issues[0]?.message).toMatch(/alternative/);
    expect(verdictFor(policy, 'curl x')).toMatchObject({ decision: 'deny', ruleId: 'no-curl' });
    expect(verdictFor(policy, 'nc host 1')).toMatchObject({ decision: 'deny', ruleId: 'no-nc' });
    expect(verdictFor(policy, 'wget x').decision).toBe('allow');
    expect(verdictFor(policy, 'rm -rf x').decision).toBe('deny');
  });

  it('isolates a rule that is not even an object', () => {
    const { policy, issues } = resolve({ version: 1, rules: [null, 'rule', 4, aRule({ id: 'no-curl' })], profiles: { default: { rules: ['no-curl'] } } });

    expect(issues).toHaveLength(3);
    expect(verdictFor(policy, 'curl x').decision).toBe('deny');
  });

  it('keeps the delivered rule when the replacement is invalid', () => {
    const { policy, issues } = resolve({ version: 1, rules: [{ id: 'no-forced-recursive-rm', decision: 'deny' }] });

    expect(issues).toHaveLength(1);
    expect(verdictFor(policy, 'rm -rf x').decision).toBe('deny');
  });

  it.each([
    ['not an object', 'text'],
    ['an array', []],
    ['null', null],
    ['an unknown version', { version: 9, mode: 'off' }],
    ['a document without a version', { mode: 'off' }],
  ])('falls back to the delivered policy when the override is %s', (_label, override) => {
    const { policy, issues } = resolve(override);

    expect(policy).toEqual(DEFAULT_COMMAND_POLICY);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ scope: 'document' });
  });

  it('ignores an invalid mode and keeps the other fields', () => {
    const { policy, issues } = resolve({ version: 1, mode: 'loud', disabledRules: ['no-forced-git-clean'] });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ scope: 'field', field: 'mode' });
    expect(policy.mode).toBe('enforce');
    expect(verdictFor(policy, 'git clean -fd').decision).toBe('allow');
  });

  it('ignores an invalid profile and keeps the valid ones', () => {
    const { policy, issues } = resolve({ version: 1, profiles: { broken: { rules: 'all' }, qa: { rules: ['no-forced-git-clean'] } } });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ scope: 'profile', profile: 'broken' });
    expect(policy.profiles.qa).toEqual({ rules: ['no-forced-git-clean'] });
    expect(policy.profiles.broken).toBeUndefined();
  });

  it('ignores a role mapping to an unknown profile', () => {
    const { policy, issues } = resolve({ version: 1, roleToProfile: { OPS: 'nowhere', SRE: 'dev' } });

    expect(issues).toHaveLength(1);
    expect(policy.roleToProfile).toMatchObject({ SRE: 'dev' });
    expect(policy.roleToProfile).not.toHaveProperty('OPS');
  });

  it('terminates when profiles extend each other in a loop', () => {
    const { policy } = resolve({ version: 1, profiles: { default: { extends: 'dev', rules: ['no-forced-recursive-rm'] } } });

    expect(verdictFor(policy, 'rm -rf x').decision).toBe('deny');
  });
});
