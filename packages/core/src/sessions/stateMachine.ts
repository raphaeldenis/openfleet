import type { ClaudeHookEvent, SessionState } from '@openfleet/shared';

export type SessionInput =
  | { kind: 'hook'; event: ClaudeHookEvent }
  | { kind: 'permission_resolved' }
  | { kind: 'harness_exit' };

export function nextState(current: SessionState, input: SessionInput): SessionState {
  if (current === 'closed') return 'closed';
  if (input.kind === 'harness_exit') return 'closed';
  if (input.kind === 'permission_resolved') return 'generating';
  return stateAfterHook(current, input.event);
}

function stateAfterHook(current: SessionState, event: ClaudeHookEvent): SessionState {
  switch (event.hook_event_name) {
    case 'SessionStart': return 'idle';
    case 'SessionEnd': return 'closed';
    case 'UserPromptSubmit': return 'generating';
    case 'PreToolUse':
    case 'PostToolUse': return 'generating';
    case 'PermissionRequest': return 'waiting_permission';
    case 'Stop': return 'idle';
    case 'Notification': return stateAfterNotification(current, event.notification_type);
  }
}

function stateAfterNotification(current: SessionState, notificationType: string): SessionState {
  if (notificationType === 'permission_prompt') return 'waiting_permission';
  if (notificationType === 'agent_needs_input') return 'waiting_input';
  if (notificationType === 'idle_prompt') return isWaitingOnHuman(current) ? current : 'idle';
  return current;
}

function isWaitingOnHuman(state: SessionState): boolean {
  return state === 'waiting_permission' || state === 'waiting_input';
}

// A hook that only fires while the CLI waits on its composer proves the last turn is over, even when the
// recorded state already says idle because that turn's UserPromptSubmit never arrived.
export function provesTurnEnded(input: SessionInput): boolean {
  if (input.kind !== 'hook') return false;
  const { event } = input;
  if (event.hook_event_name === 'Stop' || event.hook_event_name === 'SessionStart') return true;
  if (event.hook_event_name !== 'Notification') return false;
  return event.notification_type === 'idle_prompt' || event.notification_type === 'agent_needs_input';
}

export function canDeliverNow(state: SessionState): boolean {
  return state === 'idle' || state === 'waiting_input';
}
