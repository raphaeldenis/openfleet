import * as z from 'zod';
import { CreateIntegrationBodySchema, CreateIntegrationConnectionBodySchema } from '@openfleet/shared';
import type { IntegrationService } from '../integrations/integrationService.js';
import { json, queryParams, type Router } from './router.js';

const ListQuerySchema = z.object({ projectId: z.string().min(1).max(128) });

/**
 * The connections to providers and the integrations of projects, under /api behind the admin token.
 * A body never carries a credential: the schemas refuse unknown fields, and the value is set through the secrets route of the connection with the operator nonce.
 */
export function registerIntegrationRoutes(router: Router, deps: { integrations: Pick<IntegrationService, 'createConnection' | 'listConnections' | 'createIntegration' | 'list'> }): void {
  router.add('GET', '/api/integration-connections', ({ res }) => json(res, 200, deps.integrations.listConnections()));

  router.add('POST', '/api/integration-connections', ({ res, body }) => {
    json(res, 201, deps.integrations.createConnection(CreateIntegrationConnectionBodySchema.parse(body)));
  });

  router.add('GET', '/api/integrations', ({ req, res }) => {
    const { projectId } = ListQuerySchema.parse(queryParams(req));
    json(res, 200, deps.integrations.list(projectId));
  });

  router.add('POST', '/api/integrations', async ({ res, body }) => {
    json(res, 201, await deps.integrations.createIntegration(CreateIntegrationBodySchema.parse(body)));
  });
}
