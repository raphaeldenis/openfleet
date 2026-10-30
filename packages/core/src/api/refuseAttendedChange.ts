import { OpenFleetError } from '@openfleet/shared';

const SESSION_OR_MANAGER_ROUTE = /^\/api\/(sessions|managers)\/[^/]+(\/|$)/;

/** Throws invalid_body when a request aimed at an existing session or manager carries `attended`, which is set at creation only. */
export function refuseAttendedChange(pathname: string, body: unknown): void {
  const targetsExistingSessionOrManager = SESSION_OR_MANAGER_ROUTE.test(pathname);
  const carriesAttended = typeof body === 'object' && body !== null && 'attended' in body;
  if (targetsExistingSessionOrManager && carriesAttended) throw new OpenFleetError('invalid_body', 'attended is immutable after creation.');
}
