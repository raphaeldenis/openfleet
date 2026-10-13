import { WORKING_STATE_TOOL_NAMES, type NotificationTrigger, type SessionState } from '@openfleet/shared';
import type { SessionInput } from './stateMachine.js';

export interface StateTransition {
  sessionId: string;
  input: SessionInput;
  to: SessionState;
  /** When the session entered `to`: names the prompt a transition into a waiting state opens. */
  at: string;
}

/**
 * Returns what the human should hear about a state transition, or undefined when it deserves no alert.
 * Only real transitions are judged, so a repeated Stop, idle_prompt or permission_prompt never alerts twice.
 */
export function notificationTriggerOf(transition: StateTransition): NotificationTrigger | undefined {
  return agentFinishedBy(transition) ?? needsInputBy(transition);
}

function agentFinishedBy({ sessionId, input, to }: StateTransition): NotificationTrigger | undefined {
  const isStopThatEndsTheTurn = input.kind === 'hook' && input.event.hook_event_name === 'Stop' && !input.turnContinues;
  if (!isStopThatEndsTheTurn || to !== 'idle') return undefined;
  return { category: 'agentFinished', sessionId };
}

function needsInputBy({ sessionId, input, to, at }: StateTransition): NotificationTrigger | undefined {
  const kind = needsInputKindOf(to);
  if (!kind) return undefined;
  const promptKey = `${sessionId}@${at}`;
  const toolName = permissionToolNameOf(input);
  const isAutoAllowedWorkingStateTool = toolName !== undefined && (WORKING_STATE_TOOL_NAMES as readonly string[]).includes(toolName);
  if (isAutoAllowedWorkingStateTool) return undefined;
  return { category: 'needsInput', sessionId, kind, promptKey, ...(toolName && { toolName }) };
}

function needsInputKindOf(state: SessionState): 'permission' | 'input' | undefined {
  if (state === 'waiting_permission') return 'permission';
  if (state === 'waiting_input') return 'input';
  return undefined;
}

function permissionToolNameOf(input: SessionInput): string | undefined {
  if (input.kind !== 'hook') return undefined;
  const { event } = input;
  return event.hook_event_name === 'PermissionRequest' ? event.tool_name : undefined;
}
