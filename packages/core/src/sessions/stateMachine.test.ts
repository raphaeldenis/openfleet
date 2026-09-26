import { describe, expect, it } from 'vitest';
import { canDeliverNow, nextState, provesTurnEnded } from './stateMachine.js';

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
    // A stray idle_prompt while a human decision is pending must not clear that pending state —
    // observed live: Claude Code fires it during a long-open permission dialog, and the daemon was
    // wrongly showing the session as idle while an approval sat waiting in the inbox.
    ['waiting_permission', hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }), 'waiting_permission'],
    ['waiting_input', hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }), 'waiting_input'],
    ['waiting_permission', hook({ hook_event_name: 'Stop' }), 'idle'],
    ['waiting_permission', hook({ hook_event_name: 'UserPromptSubmit' }), 'generating'],
    ['starting', hook({ hook_event_name: 'SessionStart', source: 'startup' }), 'idle'],
    ['starting', hook({ hook_event_name: 'SessionStart', source: 'resume' }), 'idle'],
    ['generating', hook({ hook_event_name: 'SessionStart', source: 'clear' }), 'idle'],
    // Claude Code compacts context on its own mid-turn: that SessionStart says nothing about the turn.
    ['generating', hook({ hook_event_name: 'SessionStart', source: 'compact' }), 'generating'],
    ['waiting_permission', hook({ hook_event_name: 'SessionStart', source: 'compact' }), 'waiting_permission'],
  ] as const)('%s + %o → %s', (from, input, expected) => {
    expect(nextState(from, input)).toBe(expected);
  });
});

describe('provesTurnEnded', () => {
  it('accepts a SessionStart from a startup, resume or clear, never from a compaction', () => {
    expect(provesTurnEnded(hook({ hook_event_name: 'SessionStart', source: 'startup' }))).toBe(true);
    expect(provesTurnEnded(hook({ hook_event_name: 'SessionStart', source: 'resume' }))).toBe(true);
    expect(provesTurnEnded(hook({ hook_event_name: 'SessionStart', source: 'clear' }))).toBe(true);
    expect(provesTurnEnded(hook({ hook_event_name: 'SessionStart', source: 'compact' }))).toBe(false);
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
