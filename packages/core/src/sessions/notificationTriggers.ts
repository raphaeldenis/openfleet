import { TODO_TOOL_NAMES, WORKING_STATE_TOOL_NAMES, type NotificationTrigger, type SessionState } from '@openfleet/shared';
import type { SessionInput } from './stateMachine.js';

const DAEMON_OWNED_TOOL_NAMES = [...WORKING_STATE_TOOL_NAMES, ...TODO_TOOL_NAMES];

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

/** Returns agentFinished for a Stop that ends the turn and leaves the session idle, whether or not the recorded state changed. */
export function agentFinishedBy({ sessionId, input, to }: Omit<StateTransition, 'at'>): NotificationTrigger | undefined {
  const isStopThatEndsTheTurn = input.kind === 'hook' && input.event.hook_event_name === 'Stop' && !input.turnContinues;
  if (!isStopThatEndsTheTurn || to !== 'idle') return undefined;
  return { category: 'agentFinished', sessionId };
}

/** Returns toolCompletion for a PostToolUse of a top-level agent that names its tool run, unless the tool belongs to OpenFleet itself. */
export function toolCompletionBy({ sessionId, input }: { sessionId: string; input: SessionInput }): NotificationTrigger | undefined {
  if (input.kind !== 'hook' || input.event.hook_event_name !== 'PostToolUse') return undefined;
  const { tool_name: toolName, tool_use_id: toolUseId, agent_id: agentId } = input.event;
  const isRunBySubAgent = agentId !== undefined;
  const isDaemonOwnedTool = (DAEMON_OWNED_TOOL_NAMES as readonly string[]).includes(toolName);
  if (isRunBySubAgent || isDaemonOwnedTool || !toolUseId) return undefined;
  return { category: 'toolCompletion', sessionId, toolUseId, toolName };
}

/** Returns chatMessage for the questions an agent newly asks the human; none when the update asks nothing new. */
export function chatMessageBy({ sessionId, askedAt, newQuestionCount }: { sessionId: string; askedAt: string; newQuestionCount: number }): NotificationTrigger | undefined {
  if (newQuestionCount === 0) return undefined;
  return { category: 'chatMessage', sessionId, questionKey: `${sessionId}@${askedAt}`, questionCount: newQuestionCount };
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
