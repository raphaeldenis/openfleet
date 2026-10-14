import { describe, expect, it } from 'vitest';
import { ClaudeHookEventSchema } from './hooks.js';

const subagentPreToolUse = {
  session_id: 's', transcript_path: '/t.jsonl', cwd: '/w', prompt_id: 'p1', permission_mode: 'default', agent_id: 'a0000000000000001', agent_type: 'general-purpose',
  effort: { level: 'medium' }, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tu1',
};

describe('the fields a Claude hook carries about who is calling', () => {
  it('keeps the agent id and type of a sub-agent call', () => {
    const parsed = ClaudeHookEventSchema.parse(subagentPreToolUse);

    expect(parsed).toMatchObject({ agent_id: 'a0000000000000001', agent_type: 'general-purpose', prompt_id: 'p1', permission_mode: 'default', effort: { level: 'medium' } });
  });

  it('keeps the permission suggestions of a permission request', () => {
    const suggestions = [{ type: 'addDirectories', directories: ['/x'], destination: 'session' }];

    const parsed = ClaudeHookEventSchema.parse({ ...subagentPreToolUse, hook_event_name: 'PermissionRequest', permission_suggestions: suggestions });

    expect(parsed).toMatchObject({ permission_suggestions: suggestions });
  });

  it('accepts a payload that carries none of them', () => {
    const parsed = ClaudeHookEventSchema.safeParse({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} });

    expect(parsed.success).toBe(true);
  });

  it('accepts the sub-agent launching tool call, which carries no agent id itself', () => {
    const parsed = ClaudeHookEventSchema.safeParse({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose' } });

    expect(parsed.success).toBe(true);
  });
});
