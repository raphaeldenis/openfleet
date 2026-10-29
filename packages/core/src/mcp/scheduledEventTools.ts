import { MANAGER_ROLE, OpenFleetError, type Session } from '@openfleet/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { localDateTimeOf } from '../managers/localDateTime.js';
import type { ManagerService } from '../managers/managerService.js';
import type { ScheduledEvent } from '../managers/scheduledEventRepository.js';
import type { ScheduledEventService } from '../managers/scheduledEventService.js';
import { ok } from './toolResults.js';

/** An event as a manager reads it: the due time in UTC and in the user's local wall clock. */
export const scheduledEventView = (event: ScheduledEvent) => ({
  id: event.id,
  ...(event.title && { title: event.title }),
  message: event.message,
  creator: event.creator,
  due_at: event.dueAt,
  due_local: localDateTimeOf(new Date(event.dueAt)),
});

export interface ScheduledEventToolDeps {
  scheduledEvents: ScheduledEventService;
  managers: Pick<ManagerService, 'get'>;
  caller: Session;
}

export function registerScheduledEventTools(server: McpServer, { scheduledEvents, managers, caller }: ScheduledEventToolDeps): void {
  const requireManagerCaller = (): void => {
    const isManager = caller.role === MANAGER_ROLE && managers.get(caller.id) !== undefined;
    if (!isManager) throw new OpenFleetError('not_a_manager', 'scheduled events are for managers.', { hint: 'only a manager schedules a message to itself.' });
  };

  server.registerTool('schedule_argus_event', {
    description: 'Schedule a message to yourself, delivered once at a local time (at) or after a delay (in_minutes), prefixed [scheduled event …]. Delivered late rather than lost if the app was closed; held while you are disabled or closed.',
    inputSchema: {
      message: z.string().describe('The text you receive when the event is due (max 8192 bytes)'),
      title: z.string().optional().describe('A short label shown in the delivered line and in the list (max 80 characters)'),
      at: z.string().optional().describe('Local time of the user without offset, e.g. 2026-10-31T09:30:00; exclusive with in_minutes'),
      in_minutes: z.number().optional().describe('Minutes from now; exclusive with at'),
    },
  }, async ({ message, title, at, in_minutes }) => {
    requireManagerCaller();
    const event = scheduledEvents.schedule({ managerId: caller.id, creator: 'manager', message, title, at, inMinutes: in_minutes });
    return ok(scheduledEventView(event));
  });

  server.registerTool('list_argus_events', { description: 'Your pending scheduled events, soonest first', inputSchema: {} }, async () => {
    requireManagerCaller();
    return ok({ events: scheduledEvents.pendingOf(caller.id).map(scheduledEventView) });
  });

  server.registerTool('cancel_argus_event', {
    description: 'Cancel a pending scheduled event that you scheduled',
    inputSchema: { event_id: z.string() },
  }, async ({ event_id }) => {
    requireManagerCaller();
    scheduledEvents.cancel({ managerId: caller.id, eventId: event_id, actor: 'manager' });
    return ok({ cancelled: event_id });
  });
}
