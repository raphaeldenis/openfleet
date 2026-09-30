import { ClaudeHookEventSchema, WORKING_STATE_TOOL_NAMES, type ContextHookOutput, type StopHookOutput } from '@openfleet/shared';
import type { SessionStartContext, SessionStartRequest } from '../workingState/sessionStartContext.js';
import type { ApprovalService } from '../governance/approvalService.js';
import { log } from '../logger.js';
import type { SessionService } from '../sessions/sessionService.js';
import { handoverReminder, type HandoverLedger } from '../workingState/handoverLedger.js';
import type { StopRefusal } from '../workingState/stopRefusal.js';
import { json, type Handler } from './router.js';

function decideStopRefusalFailingOpen(stopRefusal: StopRefusal | undefined, sessionId: string, stopHookActive: boolean): StopHookOutput | undefined {
  try {
    return stopRefusal?.decide({ sessionId, stopHookActive });
  } catch (error) {
    log('warn', `stop refusal check failed, letting the turn end: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function buildSessionStartContextFailingOpen(sessionStartContext: SessionStartContext | undefined, request: SessionStartRequest): ContextHookOutput | undefined {
  try {
    return sessionStartContext?.build(request);
  } catch (error) {
    log('warn', `session start context failed, injecting nothing: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function recordHandoversFailingOpen(handoverLedger: HandoverLedger | undefined, request: { sessionId: string; prompt: string | undefined }): ContextHookOutput | undefined {
  try {
    const recorded = handoverLedger?.record(request) ?? [];
    if (recorded.length === 0) return undefined;
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: handoverReminder(recorded) } };
  } catch (error) {
    log('warn', `handover recording failed, recording nothing: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export function hooksHandler(deps: { sessions: SessionService; approvals: ApprovalService; stopRefusal?: StopRefusal; sessionStartContext?: SessionStartContext; handoverLedger?: HandoverLedger }): Handler {
  return async ({ res, params, body }) => {
    const session = deps.sessions.byHookToken(params.hookToken ?? '');
    const parsed = ClaudeHookEventSchema.safeParse(body);
    const isIgnorable = !session || !parsed.success || session.state === 'closed';
    if (isIgnorable) return json(res, 200, {});

    const event = parsed.data;
    const stopRefusal = event.hook_event_name === 'Stop' ? decideStopRefusalFailingOpen(deps.stopRefusal, session.id, event.stop_hook_active === true) : undefined;
    const previousTranscriptPath = deps.sessions.transcriptPathOf(session.id);
    const sessionStartContext = event.hook_event_name === 'SessionStart' ? buildSessionStartContextFailingOpen(deps.sessionStartContext, { sessionId: session.id, source: event.source, previousTranscriptPath }) : undefined;
    const handoverReminderOutput = event.hook_event_name === 'UserPromptSubmit' ? recordHandoversFailingOpen(deps.handoverLedger, { sessionId: session.id, prompt: event.prompt }) : undefined;
    deps.sessions.applyInput(session.id, { kind: 'hook', event, turnContinues: stopRefusal !== undefined });
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
