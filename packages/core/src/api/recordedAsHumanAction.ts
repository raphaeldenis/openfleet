import { OpenFleetError } from '@openfleet/shared';
import type { ActivityRecorder } from '../activity/activityRecorder.js';
import { failureDetailOf, outcomeOfErrorCode } from '../activity/refusalOutcome.js';
import { restActionOf } from '../activity/restActionNames.js';

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
// Asking for the ticket of the live connection is part of opening the app, not an action of the human.
const ROUTES_THAT_ARE_NO_ACTION: ReadonlySet<string> = new Set(['POST /api/ws-ticket']);

/** Runs a REST handler behind the admin token and records the mutation as an action of the human; a read passes through. The failure of the handler is recorded and thrown again. */
export async function recordedAsHumanAction(
  recorder: Pick<ActivityRecorder, 'record'>,
  request: { method: string; template: string; params: Record<string, string> },
  run: () => Promise<void> | void,
): Promise<void> {
  const isRead = READ_METHODS.has(request.method);
  const isNoAction = ROUTES_THAT_ARE_NO_ACTION.has(`${request.method} ${request.template}`);
  if (isRead || isNoAction) return await run();

  const { action, entity } = restActionOf(request);
  const entityId = entity === undefined ? undefined : request.params[entity.idParam];
  const startedAt = performance.now();
  const record = (outcome: 'ok' | 'denied' | 'error', detail?: string) => recorder.record({
    actorKind: 'human', actorLabel: 'admin', source: 'rest', action, outcome,
    durationMs: Math.round(performance.now() - startedAt),
    ...(entity === undefined ? {} : { entityKind: entity.kind }),
    ...(entityId === undefined ? {} : { entityId }),
    ...(detail === undefined ? {} : { detail }),
  });
  try {
    await run();
    record('ok');
  } catch (error) {
    record(outcomeOfErrorCode(error instanceof OpenFleetError ? error.code : undefined), failureDetailOf(error));
    throw error;
  }
}
