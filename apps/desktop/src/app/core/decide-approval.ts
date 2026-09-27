import { ApiError, FleetApiService } from './fleet-api.service';

export const GENERIC_DECISION_ERROR = 'Could not send decision — try again.';

export type DecisionOutcome = { outcome: 'ok' } | { outcome: 'already-resolved' } | { outcome: 'failed'; message: string };

/** Sends an allow/deny decision and classifies the result — a 409 means someone else already resolved it. */
export async function decideApproval(api: FleetApiService, id: string, behavior: 'allow' | 'deny'): Promise<DecisionOutcome> {
  try {
    await api.decide(id, behavior);
    return { outcome: 'ok' };
  } catch (error) {
    const isAlreadyResolved = error instanceof ApiError && error.status === 409;
    return isAlreadyResolved ? { outcome: 'already-resolved' } : { outcome: 'failed', message: GENERIC_DECISION_ERROR };
  }
}
