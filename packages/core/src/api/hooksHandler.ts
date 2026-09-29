import { ClaudeHookEventSchema, WORKING_STATE_TOOL_NAMES } from '@openfleet/shared';
import type { ApprovalService } from '../governance/approvalService.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { StopRefusal } from '../workingState/stopRefusal.js';
import { json, type Handler } from './router.js';

export function hooksHandler(deps: { sessions: SessionService; approvals: ApprovalService; stopRefusal?: StopRefusal }): Handler {
  return async ({ res, params, body }) => {
    const session = deps.sessions.byHookToken(params.hookToken ?? '');
    const parsed = ClaudeHookEventSchema.safeParse(body);
    const isIgnorable = !session || !parsed.success || session.state === 'closed';
    if (isIgnorable) return json(res, 200, {});

    const event = parsed.data;
    const stopRefusal = event.hook_event_name === 'Stop'
      ? deps.stopRefusal?.decide({ sessionId: session.id, stopHookActive: event.stop_hook_active === true })
      : undefined;
    deps.sessions.applyInput(session.id, { kind: 'hook', event, turnContinues: stopRefusal !== undefined });
    if (stopRefusal) return json(res, 200, stopRefusal);
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
