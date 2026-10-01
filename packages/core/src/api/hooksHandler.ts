import { ClaudeHookEventSchema, TODO_TOOL_NAMES, WORKING_STATE_TOOL_NAMES, type ClaudeHookEvent, type ContextHookOutput, type StopHookOutput } from '@openfleet/shared';
import { narrowTodoHookCall, withoutTodoPayload, type TodoHookCall } from '../todos/todoHookCall.js';
import type { TodoTracker } from '../todos/todoTracker.js';
import type { ContextNotice } from '../workingState/contextNotice.js';
import type { SessionStartContext, SessionStartRequest } from '../workingState/sessionStartContext.js';
import type { ApprovalService } from '../governance/approvalService.js';
import { log } from '../logger.js';
import type { DegradedRegistry } from '../process/degradedRegistry.js';
import type { SessionService } from '../sessions/sessionService.js';
import { handoverReminder, type HandoverLedger } from '../workingState/handoverLedger.js';
import type { StopRefusal } from '../workingState/stopRefusal.js';
import { json, type Handler } from './router.js';

/** Runs `work`; a throw is logged, counted toward the degraded state, and answered as if the feature were absent (undefined). */
function failingOpen<T>(degraded: DegradedRegistry | undefined, failure: string, work: () => T): T | undefined {
  try {
    return work();
  } catch (error) {
    log('warn', `${failure}: ${error instanceof Error ? error.message : String(error)}`);
    degraded?.recordHookFailOpen();
    return undefined;
  }
}

// Only enqueues: the fold and the reads run after the hook is answered, on the session's own queue.
function trackTodosFailingOpen(todos: TodoTracker | undefined, sessionId: string, event: ClaudeHookEvent, todoCall: TodoHookCall | undefined): void {
  try {
    if (!todos) return;
    const isTodoToolCall = event.hook_event_name === 'PostToolUse' && (TODO_TOOL_NAMES as readonly string[]).includes(event.tool_name);
    if (isTodoToolCall && todoCall) todos.applyHook(sessionId, todoCall);
    if (isTodoToolCall && !todoCall) todos.readAfterHookWithoutPayload(sessionId);
    if (event.hook_event_name === 'SessionStart' && event.source === 'resume') todos.repair(sessionId);
    if (event.hook_event_name === 'Stop' || event.hook_event_name === 'SessionEnd') todos.catchUp(sessionId);
  } catch {
    log('warn', 'todos: a hook could not be handed to the todo tracker, changing nothing', undefined, { code: 'todo_notify_failed', sessionId });
  }
}

export function hooksHandler(deps: { sessions: SessionService; approvals: ApprovalService; stopRefusal?: StopRefusal; sessionStartContext?: SessionStartContext; handoverLedger?: HandoverLedger; contextNotice?: ContextNotice; todos?: TodoTracker; degraded?: DegradedRegistry }): Handler {
  const decideStopRefusalFailingOpen = (sessionId: string, stopHookActive: boolean): StopHookOutput | undefined =>
    failingOpen(deps.degraded, 'stop refusal check failed, letting the turn end', () => deps.stopRefusal?.decide({ sessionId, stopHookActive }));

  const buildSessionStartContextFailingOpen = (request: SessionStartRequest): ContextHookOutput | undefined =>
    failingOpen(deps.degraded, 'session start context failed, injecting nothing', () => deps.sessionStartContext?.build(request));

  const recordHandoversFailingOpen = (request: { sessionId: string; prompt: string | undefined }): ContextHookOutput | undefined =>
    failingOpen(deps.degraded, 'handover recording failed, recording nothing', () => {
      const recorded = deps.handoverLedger?.record(request) ?? [];
      if (recorded.length === 0) return undefined;
      return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit' as const, additionalContext: handoverReminder(recorded) } };
    });

  const trackContextNoticeFailingOpen = (sessionId: string, event: ClaudeHookEvent): void =>
    failingOpen(deps.degraded, 'context notice failed, changing nothing', () => {
      if (event.hook_event_name === 'Stop') deps.contextNotice?.measureAtStop(sessionId);
      if (event.hook_event_name === 'UserPromptSubmit') deps.contextNotice?.measureAtPrompt(sessionId);
      const startsFreshConversation = event.hook_event_name === 'SessionStart' && (event.source === 'clear' || event.source === 'compact');
      if (startsFreshConversation) deps.contextNotice?.clearForNewConversation(sessionId);
    });

  return async ({ res, params, body }) => {
    const session = deps.sessions.byHookToken(params.hookToken ?? '');
    const parsed = ClaudeHookEventSchema.safeParse(body);
    const isIgnorable = !session || !parsed.success || session.state === 'closed';
    if (isIgnorable) return json(res, 200, {});

    const todoCall = parsed.data.hook_event_name === 'PostToolUse' ? narrowTodoHookCall(parsed.data) : undefined;
    const event = withoutTodoPayload(parsed.data);
    const stopRefusal = event.hook_event_name === 'Stop' ? decideStopRefusalFailingOpen(session.id, event.stop_hook_active === true) : undefined;
    const previousTranscriptPath = deps.sessions.transcriptPathOf(session.id);
    const sessionStartContext = event.hook_event_name === 'SessionStart' ? buildSessionStartContextFailingOpen({ sessionId: session.id, source: event.source, previousTranscriptPath }) : undefined;
    const isDaemonSeededPrompt = event.hook_event_name === 'UserPromptSubmit' && event.prompt !== undefined && deps.sessions.isSeededPrompt(session.id, event.prompt);
    const handoverReminderOutput = event.hook_event_name === 'UserPromptSubmit' && !isDaemonSeededPrompt ? recordHandoversFailingOpen({ sessionId: session.id, prompt: event.prompt }) : undefined;
    deps.sessions.applyInput(session.id, { kind: 'hook', event, turnContinues: stopRefusal !== undefined });
    trackContextNoticeFailingOpen(session.id, event);
    trackTodosFailingOpen(deps.todos, session.id, event, todoCall);
    if (stopRefusal) return json(res, 200, stopRefusal);
    if (sessionStartContext) return json(res, 200, sessionStartContext);
    if (handoverReminderOutput) return json(res, 200, handoverReminderOutput);
    if (event.hook_event_name !== 'PermissionRequest') return json(res, 200, {});

    const isWorkingStateTool = (WORKING_STATE_TOOL_NAMES as readonly string[]).includes(event.tool_name);
    if (isWorkingStateTool) {
      deps.sessions.applyInput(session.id, { kind: 'permission_resolved' });
      return json(res, 200, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    }

    const decision = await deps.approvals.request({ sessionId: session.id, toolName: event.tool_name, toolInput: event.tool_input });
    deps.sessions.applyInput(session.id, { kind: 'permission_resolved' });
    if (decision === 'ask') return json(res, 200, {});
    const message = decision === 'deny' ? 'denied in OpenFleet' : undefined;
    return json(res, 200, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: decision, message } } });
  };
}
