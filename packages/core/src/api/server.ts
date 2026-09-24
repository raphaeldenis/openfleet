import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { EventBus } from '../events/eventBus.js';
import type { ApprovalService } from '../governance/approvalService.js';
import type { SessionService } from '../sessions/sessionService.js';
import { hooksHandler } from './hooksHandler.js';
import { registerRestRoutes } from './restHandlers.js';
import { json, readJson, Router } from './router.js';
import { createWsHandler } from './wsHandler.js';

export interface ServerDeps {
  host: string; port: number; adminToken: string;
  sessions: SessionService; approvals: ApprovalService; bus: EventBus;
  mcp?: (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void>;
}

export async function startServer(deps: ServerDeps): Promise<{ url: string; close(): Promise<void> }> {
  const router = new Router();
  router.add('POST', '/hooks/:hookToken', hooksHandler(deps));
  registerRestRoutes(router, deps);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${deps.host}`);
    try {
      if (url.pathname === '/mcp' && deps.mcp) return await deps.mcp(req, res, await readJson(req));
      const match = router.match(req.method ?? 'GET', url.pathname);
      if (!match) return json(res, 404, { error: 'not_found' });
      const isProtected = url.pathname.startsWith('/api/');
      if (isProtected && req.headers.authorization !== `Bearer ${deps.adminToken}`) return json(res, 401, { error: 'unauthorized' });
      await match.handler({ req, res, params: match.params, body: await readJson(req) });
    } catch (error) {
      const isValidation = (error as { name?: string }).name === 'ZodError';
      json(res, isValidation ? 400 : 500, { error: isValidation ? 'invalid_body' : 'internal', detail: (error as Error).message });
    }
  });
  server.on('upgrade', createWsHandler(deps));

  await new Promise<void>((resolve) => server.listen(deps.port, deps.host, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : deps.port;
  return {
    url: `http://${deps.host}:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
