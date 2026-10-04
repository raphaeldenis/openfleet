import { MAX_NOTE_PAGE_LIMIT, pageQuerySchema } from '@openfleet/shared';
import type { HandoffSeed } from '../notes/handoffSeed.js';
import { json, queryParams, type Router } from './router.js';

const HandoffPageQuerySchema = pageQuerySchema(MAX_NOTE_PAGE_LIMIT);

export function registerHandoffPickerRoutes(router: Router, handoffs: Pick<HandoffSeed, 'list'>): void {
  router.add('GET', '/api/projects/:id/handoffs', ({ req, res, params }) => {
    const page = HandoffPageQuerySchema.parse(queryParams(req));
    json(res, 200, handoffs.list({ projectId: params.id!, ...page }));
  });
}
