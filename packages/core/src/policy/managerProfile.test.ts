import type { CommandPolicyDocument, PolicyRequest } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { ASK_USER_QUESTION_TOOL, DEFAULT_COMMAND_POLICY, MANAGER_ASK_USER_RULE_ID } from './defaultCommandPolicy.js';
import { evaluateCommandPolicy } from './policyEvaluator.js';
import { bashRequest, fileToolRequest, policyRequest } from './policyRequest.testkit.js';

const MANAGER = 'manager';

/** The delivered policy as it was before the manager profile: no manager profile, no role mapping, no ask-user rule. */
const policyWithoutManagerProfile: CommandPolicyDocument = (() => {
  const { manager: _managerProfile, ...profiles } = DEFAULT_COMMAND_POLICY.profiles;
  const { manager: _managerMapping, ...roleToProfile } = DEFAULT_COMMAND_POLICY.roleToProfile;
  return { ...DEFAULT_COMMAND_POLICY, profiles, roleToProfile, rules: DEFAULT_COMMAND_POLICY.rules.filter((rule) => rule.id !== MANAGER_ASK_USER_RULE_ID) };
})();

const callsExceptAskUserQuestion = (): PolicyRequest[] => [
  bashRequest('ls -la'),
  bashRequest('rm -rf build'),
  bashRequest('rm -r build'),
  bashRequest('git clean -fd'),
  bashRequest('git commit -m "x"'),
  bashRequest('git push origin main'),
  bashRequest('find / -delete'),
  bashRequest('pnpm test'),
  bashRequest('pnpm --filter @openfleet/core test'),
  bashRequest('vitest run', { model: 'claude-opus-5-5' }),
  bashRequest('grep -rn foo .'),
  bashRequest('echo hi > /tmp/out.txt'),
  bashRequest('cat README.md', { worktreeRoot: '/work/repo' }),
  bashRequest('gh pr create --title x'),
  bashRequest('gh pr merge 1'),
  fileToolRequest('Write', '/work/repo/.git/config'),
  fileToolRequest('Edit', '/work/repo/src/a.ts'),
  fileToolRequest('NotebookEdit', '/work/repo/n.ipynb'),
  policyRequest({ toolName: 'ExitPlanMode' }),
  policyRequest({ toolName: 'SendMessage', recipient: 'Lead', recipientNamesManager: true }),
  policyRequest({ toolName: 'Read', filePaths: ['/work/repo/a.ts'] }),
];

const withPresences = (requests: PolicyRequest[]): PolicyRequest[] =>
  requests.flatMap((request) => [{ ...request, presence: 'attended' as const }, { ...request, presence: 'unattended' as const }, { ...request, actor: 'subagent' as const }]);

describe('the manager profile of the delivered policy', () => {
  it('judges every call except AskUserQuestion exactly as a manager was judged before the profile existed', () => {
    for (const request of withPresences(callsExceptAskUserQuestion())) {
      const manager = { ...request, role: MANAGER };

      expect(evaluateCommandPolicy(manager, DEFAULT_COMMAND_POLICY), `${request.toolName} ${request.command ?? request.filePaths ?? ''} ${request.presence} ${request.actor}`)
        .toEqual(evaluateCommandPolicy(manager, policyWithoutManagerProfile));
    }
  });

  it('keeps the mode of the profile that managers were judged by', () => {
    expect(DEFAULT_COMMAND_POLICY.profiles.manager!.mode).toBe(DEFAULT_COMMAND_POLICY.profiles.default!.mode);
    expect(DEFAULT_COMMAND_POLICY.profiles.manager!.extends).toBe('default');
  });

  it('refuses AskUserQuestion to an attended manager and points to submit_plan_questions', () => {
    const verdict = evaluateCommandPolicy(policyRequest({ toolName: ASK_USER_QUESTION_TOOL, role: MANAGER, presence: 'attended' }), DEFAULT_COMMAND_POLICY);

    expect(verdict).toMatchObject({ decision: 'deny', ruleId: MANAGER_ASK_USER_RULE_ID, alternative: expect.stringContaining('submit_plan_questions') });
  });

  it('leaves the refusal of an unattended manager to the rule that already refused it', () => {
    const request = policyRequest({ toolName: ASK_USER_QUESTION_TOOL, role: MANAGER, presence: 'unattended' });

    expect(evaluateCommandPolicy(request, DEFAULT_COMMAND_POLICY)).toEqual(evaluateCommandPolicy(request, policyWithoutManagerProfile));
  });

  it.each([undefined, 'DEV', 'QE', 'QA', 'ADV', 'REVIEW', 'arbiter', 'reviewer'])('leaves the role %s untouched, AskUserQuestion included', (role) => {
    const requests = [...callsExceptAskUserQuestion(), policyRequest({ toolName: ASK_USER_QUESTION_TOOL })];
    for (const request of withPresences(requests)) {
      const roleRequest = role === undefined ? request : { ...request, role };

      expect(evaluateCommandPolicy(roleRequest, DEFAULT_COMMAND_POLICY), `${role} ${request.toolName} ${request.command ?? ''} ${request.presence}`)
        .toEqual(evaluateCommandPolicy(roleRequest, policyWithoutManagerProfile));
    }
  });
});
