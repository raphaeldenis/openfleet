import * as z from 'zod';
import { ApproveViewConfigBodySchema, CreateIntegrationBodySchema, CreateIntegrationConnectionBodySchema, SaveViewConfigBodySchema } from '@openfleet/shared';
import type { IntegrationService } from '../integrations/integrationService.js';
import type { IntegrationViewService } from '../integrations/integrationViewService.js';
import { json, queryParams, type Router } from './router.js';
import { HUMAN_PROOF_HEADER } from './triggerRoutes.js';

const ListQuerySchema = z.object({ projectId: z.string().min(1).max(128) });

const headerValue = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/**
 * The connections to providers and the integrations of projects, under /api behind the admin token.
 * A body never carries a credential: the schemas refuse unknown fields, and the value is set through the secrets route of the connection with the operator nonce.
 * The view configuration of an integration is written as a proposal; approving it also needs the single-use proof of a human gesture, which the admin token alone does not give. No route sits under /mcp.
 */
export function registerIntegrationRoutes(router: Router, deps: {
  integrations: Pick<IntegrationService, 'createConnection' | 'listConnections' | 'createIntegration' | 'list' | 'itemsOf'>;
  views: Pick<IntegrationViewService, 'configOf' | 'propose' | 'approve'>;
}): void {
  router.add('GET', '/api/integration-connections', ({ res }) => json(res, 200, deps.integrations.listConnections()));

  router.add('POST', '/api/integration-connections', ({ res, body }) => {
    json(res, 201, deps.integrations.createConnection(CreateIntegrationConnectionBodySchema.parse(body)));
  });

  router.add('GET', '/api/integrations', ({ req, res }) => {
    const { projectId } = ListQuerySchema.parse(queryParams(req));
    json(res, 200, deps.integrations.list(projectId));
  });

  router.add('GET', '/api/integrations/:id/items', ({ req, res, params }) => {
    const { projectId } = ListQuerySchema.parse(queryParams(req));
    json(res, 200, deps.integrations.itemsOf(projectId, params.id!));
  });

  router.add('GET', '/api/integrations/:id/view-config', ({ req, res, params }) => {
    const { projectId } = ListQuerySchema.parse(queryParams(req));
    json(res, 200, deps.views.configOf(projectId, params.id!));
  });

  router.add('PUT', '/api/integrations/:id/view-config', ({ req, res, params, body }) => {
    const { projectId } = ListQuerySchema.parse(queryParams(req));
    json(res, 200, deps.views.propose(projectId, params.id!, SaveViewConfigBodySchema.parse(body)));
  });

  router.add('POST', '/api/integrations/:id/view-config/approve', ({ req, res, params, body }) => {
    const { projectId } = ListQuerySchema.parse(queryParams(req));
    const { approvedRev } = ApproveViewConfigBodySchema.parse(body);
    json(res, 200, deps.views.approve(projectId, params.id!, { approvedRev, proof: headerValue(req.headers[HUMAN_PROOF_HEADER]) }));
  });

  router.add('POST', '/api/integrations', async ({ res, body }) => {
    json(res, 201, await deps.integrations.createIntegration(CreateIntegrationBodySchema.parse(body)));
  });
}
