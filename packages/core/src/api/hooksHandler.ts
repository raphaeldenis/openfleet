import { ClaudeHookEventSchema, TODO_TOOL_NAMES, WORKING_STATE_TOOL_NAMES, type ClaudeHookEvent, type ContextHookOutput, type StopHookOutput } from '@openfleet/shared';
import { narrowTodoHookCall, withoutTodoPayload, type TodoHookCall } from '../todos/todoHookCall.js';
import type { TodoTracker } from '../todos/todoTracker.js';
import type { ContextNotice } from '../workingState/contextNotice.js';
import type { SessionStartContext, SessionStartRequest } from '../workingState/sessionStartContext.js';
import type { EventBus } from '../events/eventBus.js';
import type { ApprovalService } from '../governance/approvalService.js';
import type { CommandPolicyHooks } from '../policy/ports.js';
import { log } from '../logger.js';
import type { ManagerService } from '../managers/managerService.js';
import type { DegradedRegistry } from '../process/degradedRegistry.js';
import type { SessionService } from '../sessions/sessionService.js';
import { OncePerWindowPerKey } from '../usage/oncePerWindowPerKey.js';
import { PerSessionTrailingThrottle, type PerSessionTrailingThrottleOptions } from '../usage/perSessionTrailingThrottle.js';
import type { TranscriptUsageIngestion } from '../usage/transcriptUsageIngestion.js';
import { handoverReminder, type HandoverLedger } from '../workingState/handoverLedger.js';
import type { StopRefusal } from '../workingState/stopRefusal.js';
import { json, type Handler } from './router.js';

/** A session whose usage ingestion keeps failing adds one failure to the degraded count per window, not one per Stop. */
const USAGE_FAILURE_COUNT_WINDOW_MS = 60_000;

/** The Stops of a session cause at most one usage ingestion per window, which bounds the CPU a looping child can take. */
const USAGE_INGESTION_WINDOW_MS = 1000;

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

/** A conversation that starts, restarts or resumes has the base and the mission note only if it reads them again; a manager that never read them is unaffected. */
const SESSION_START_SOURCES_THAT_RESET_THE_BASE_AND_NOTE_READS = ['startup', 'compact', 'clear', 'resume'];

export function hooksHandler(deps: { managers?: Pick<ManagerService, 'forgetBaseRead' | 'forgetNoteRead'>; sessions: SessionService; approvals: ApprovalService; stopRefusal?: StopRefusal; sessionStartContext?: SessionStartContext; handoverLedger?: HandoverLedger; contextNotice?: ContextNotice; usageIngestion?: Pick<TranscriptUsageIngestion, 'ingestAtStop'>; usageIngestionThrottle?: Partial<PerSessionTrailingThrottleOptions>; bus?: Pick<EventBus, 'subscribe'>; todos?: TodoTracker; degraded?: DegradedRegistry; commandPolicy?: CommandPolicyHooks }): Handler & { dispose(): void } {
  const decideStopRefusalFailingOpen = (sessionId: string, stopHookActive: boolean): StopHookOutput | undefined =>
    failingOpen(deps.degraded, 'stop refusal check failed, letting the turn end', () => deps.stopRefusal?.decide({ sessionId, stopHookActive }));

  const buildSessionStartContextFailingOpen = (request: SessionStartRequest): ContextHookOutput | undefined =>
    failingOpen(deps.degraded, 'session start context failed, injecting nothing', () => deps.sessionStartContext?.build(request));

  const forgetBaseReadFailingOpen = (sessionId: string, source: string | undefined): void =>
    failingOpen(deps.degraded, 'manager base read reset failed, changing nothing', () => {
      const startsFreshContext = source !== undefined && SESSION_START_SOURCES_THAT_RESET_THE_BASE_AND_NOTE_READS.includes(source);
      if (startsFreshContext) deps.managers?.forgetBaseRead(sessionId);
      if (startsFreshContext) deps.managers?.forgetNoteRead(sessionId);
    });

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

  const stopIngestions = new PerSessionTrailingThrottle({ windowMs: USAGE_INGESTION_WINDOW_MS, ...deps.usageIngestionThrottle });

  const degradedCountsOfUsageFailures = new OncePerWindowPerKey(USAGE_FAILURE_COUNT_WINDOW_MS);

  const stopListeningToClosedSessions = deps.bus?.subscribe((event) => {
    if (event.type !== 'session.closed') return;
    stopIngestions.forget(event.sessionId);
    degradedCountsOfUsageFailures.forget(event.sessionId);
  });

  const dispose = (): void => {
    stopListeningToClosedSessions?.();
    stopIngestions.dispose();
  };

  const ingestUsageFailingOpen = (usageIngestion: Pick<TranscriptUsageIngestion, 'ingestAtStop'>, sessionId: string): void => {
    try {
      usageIngestion.ingestAtStop(sessionId);
    } catch (error) {
      log('warn', `usage ingestion failed, recording nothing: ${error instanceof Error ? error.message : String(error)}`, undefined, { code: 'usage_ingestion_failed', sessionId });
      const countsTowardDegraded = degradedCountsOfUsageFailures.admits(sessionId);
      if (countsTowardDegraded) deps.degraded?.recordHookFailOpen();
    }
  };

  const ingestUsageAfterAnswering = (sessionId: string, event: ClaudeHookEvent): void => {
    const endsTurn = event.hook_event_name === 'Stop';
    if (!endsTurn || !deps.usageIngestion) return;
    const { usageIngestion } = deps;
    stopIngestions.request(sessionId, () => ingestUsageFailingOpen(usageIngestion, sessionId));
  };

  const handleHook: Handler = async ({ res, params, body }) => {
    const session = deps.sessions.byHookToken(params.hookToken ?? '');
    const parsed = ClaudeHookEventSchema.safeParse(body);
    const isIgnorable = !session || !parsed.success || session.state === 'closed';
    if (isIgnorable) return json(res, 200, {});

    const todoCall = parsed.data.hook_event_name === 'PostToolUse' ? narrowTodoHookCall(parsed.data) : undefined;
    const event = withoutTodoPayload(parsed.data);
    if (event.hook_event_name === 'PermissionRequest') {
      const refusal = deps.commandPolicy?.onPermissionRequest(session, event);
      if (refusal) return json(res, 200, refusal);
    }
    const preToolUseAnswer = event.hook_event_name === 'PreToolUse' ? await deps.commandPolicy?.onPreToolUse(session, event) : undefined;
    const stopRefusal = event.hook_event_name === 'Stop' ? decideStopRefusalFailingOpen(session.id, event.stop_hook_active === true) : undefined;
    const previousTranscriptPath = deps.sessions.transcriptPathOf(session.id);
    if (event.hook_event_name === 'SessionStart') forgetBaseReadFailingOpen(session.id, event.source);
    const sessionStartContext = event.hook_event_name === 'SessionStart' ? buildSessionStartContextFailingOpen({ sessionId: session.id, source: event.source, previousTranscriptPath }) : undefined;
    const isDaemonSeededPrompt = event.hook_event_name === 'UserPromptSubmit' && event.prompt !== undefined && deps.sessions.isSeededPrompt(session.id, event.prompt);
    const handoverReminderOutput = event.hook_event_name === 'UserPromptSubmit' && !isDaemonSeededPrompt ? recordHandoversFailingOpen({ sessionId: session.id, prompt: event.prompt }) : undefined;
    deps.sessions.applyInput(session.id, { kind: 'hook', event, turnContinues: stopRefusal !== undefined });
    trackContextNoticeFailingOpen(session.id, event);
    ingestUsageAfterAnswering(session.id, event);
    trackTodosFailingOpen(deps.todos, session.id, event, todoCall);
    if (stopRefusal) return json(res, 200, stopRefusal);
    if (sessionStartContext) return json(res, 200, sessionStartContext);
    if (handoverReminderOutput) return json(res, 200, handoverReminderOutput);
    if (preToolUseAnswer) return json(res, 200, preToolUseAnswer);
    if (event.hook_event_name !== 'PermissionRequest') return json(res, 200, {});

    const isWorkingStateTool = (WORKING_STATE_TOOL_NAMES as readonly string[]).includes(event.tool_name);
    if (isWorkingStateTool) {
      deps.sessions.applyInput(session.id, { kind: 'permission_resolved' });
      return json(res, 200, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    }

    const decision = await deps.approvals.request({ sessionId: session.id, toolName: event.tool_name, toolInput: event.tool_input });
    const leavesCliAskingInItsTerminal = decision === 'ask';
    if (leavesCliAskingInItsTerminal) return json(res, 200, {});
    deps.sessions.applyInput(session.id, { kind: 'permission_resolved' });
    const message = decision === 'deny' ? 'denied in OpenFleet' : undefined;
    return json(res, 200, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: decision, message } } });
  };

  return Object.assign(handleHook, { dispose });
}
