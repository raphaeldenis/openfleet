import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMAND_POLICY, SEND_MESSAGE_GUARD_RULE_ID } from './defaultCommandPolicy.js';
import { evaluateCommandPolicy } from './policyEvaluator.js';
import { policyRequest } from './policyRequest.testkit.js';

const enforcing = { ...DEFAULT_COMMAND_POLICY, mode: 'enforce' as const };
const observing = { ...DEFAULT_COMMAND_POLICY, mode: 'observe' as const };

const sendMessageTo = (recipient: string, overrides: Parameters<typeof policyRequest>[0] = {}) =>
  policyRequest({ toolName: 'SendMessage', recipient, ...overrides });

const isRefusedByTheGuard = (request: ReturnType<typeof policyRequest>) => {
  const verdict = evaluateCommandPolicy(request, enforcing);
  return verdict.decision === 'deny' && verdict.ruleId === SEND_MESSAGE_GUARD_RULE_ID;
};

describe('the SendMessage guard delivered with the command policy', () => {
  it.each([
    ['a full session uuid', '3f2b8c1e-7a4d-4e5f-9b6a-0c1d2e3f4a5b'],
    ['an upper-case session uuid', '3F2B8C1E-7A4D-4E5F-9B6A-0C1D2E3F4A5B'],
    ['a uuid prefix', '3f2b8c1e'],
    ['a longer uuid prefix', '3f2b8c1e-7a4d-4e5f'],
  ])('refuses a message to %s', (_label, recipient) => {
    expect(isRefusedByTheGuard(sendMessageTo(recipient))).toBe(true);
  });

  it('refuses a message to the name of a manager session', () => {
    expect(isRefusedByTheGuard(sendMessageTo('Forge', { recipientNamesManager: true }))).toBe(true);
  });

  it.each([
    ['a sub-agent name', 'researcher'],
    ['a hyphenated sub-agent name', 'test-runner'],
    ['a short hex-looking word', 'cafe'],
    ['a name that merely starts with hex digits', 'deadbeef-worker-pool-xyz'],
    ['the broadcast target', '*'],
  ])('lets a message to %s through', (_label, recipient) => {
    expect(evaluateCommandPolicy(sendMessageTo(recipient), enforcing)).toEqual({ decision: 'allow' });
  });

  it('lets a SendMessage without a recipient through', () => {
    expect(evaluateCommandPolicy(policyRequest({ toolName: 'SendMessage' }), enforcing)).toEqual({ decision: 'allow' });
  });

  it('judges the tool SendMessage only', () => {
    const request = policyRequest({ toolName: 'Agent', recipient: '3f2b8c1e-7a4d-4e5f-9b6a-0c1d2e3f4a5b' });

    expect(evaluateCommandPolicy(request, enforcing)).toEqual({ decision: 'allow' });
  });

  it('applies to an attended manager and to a sub-agent alike', () => {
    const uuid = '3f2b8c1e-7a4d-4e5f-9b6a-0c1d2e3f4a5b';

    expect(isRefusedByTheGuard(sendMessageTo(uuid, { presence: 'attended' }))).toBe(true);
    expect(isRefusedByTheGuard(sendMessageTo(uuid, { actor: 'subagent' }))).toBe(true);
  });

  it('points to the fleet tools in a refusal short enough to read at a glance', () => {
    const verdict = evaluateCommandPolicy(sendMessageTo('3f2b8c1e-7a4d-4e5f-9b6a-0c1d2e3f4a5b'), enforcing);

    expect(verdict).toMatchObject({ decision: 'deny', alternative: expect.stringMatching(/message_argus.*send_session_message|send_session_message.*message_argus/) });
    expect(verdict.decision === 'deny' && verdict.reason.length + verdict.alternative.length).toBeLessThanOrEqual(400);
  });

  it('is observed, not refused, while the policy observes', () => {
    const verdict = evaluateCommandPolicy(sendMessageTo('3f2b8c1e-7a4d-4e5f-9b6a-0c1d2e3f4a5b'), observing);

    expect(verdict).toMatchObject({ decision: 'allow', observed: { ruleId: SEND_MESSAGE_GUARD_RULE_ID } });
  });
});
