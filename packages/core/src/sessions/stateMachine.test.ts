import { describe, expect, it } from 'vitest';
import { canDeliverNow, nextState } from './stateMachine.js';

const hook = (event: object) => ({ kind: 'hook' as const, event: { session_id: 's', ...event } as never });

describe('nextState', () => {
  it.each([
    ['starting', hook({ hook_event_name: 'SessionStart' }), 'idle'],
    ['idle', hook({ hook_event_name: 'UserPromptSubmit' }), 'generating'],
    ['generating', hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }), 'generating'],
    ['generating', hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} }), 'waiting_permission'],
    ['waiting_permission', { kind: 'permission_resolved' }, 'generating'],
    ['generating', hook({ hook_event_name: 'Notification', notification_type: 'agent_needs_input' }), 'waiting_input'],
    ['generating', hook({ hook_event_name: 'Stop' }), 'idle'],
    ['idle', hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }), 'idle'],
    ['generating', { kind: 'harness_exit' }, 'closed'],
    ['closed', hook({ hook_event_name: 'Stop' }), 'closed'],
  ] as const)('%s + %o → %s', (from, input, expected) => {
    expect(nextState(from, input)).toBe(expected);
  });
});

describe('canDeliverNow', () => {
  it('only delivers when idle or waiting for input', () => {
    expect(canDeliverNow('idle')).toBe(true);
    expect(canDeliverNow('waiting_input')).toBe(true);
    expect(canDeliverNow('generating')).toBe(false);
    expect(canDeliverNow('waiting_permission')).toBe(false);
    expect(canDeliverNow('closed')).toBe(false);
  });
});
