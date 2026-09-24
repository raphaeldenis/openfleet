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

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

export async function startServer(deps: ServerDeps): Promise<{ url: string; close(): Promise<void> }> {
  const router = new Router();
  router.add('POST', '/hooks/:hookToken', hooksHandler(deps));
  // ponytail: unauthenticated readiness probe for CI/e2e webServer checks, which run before the admin token is known
  router.add('GET', '/health', ({ res }) => json(res, 200, { ok: true }));
  registerRestRoutes(router, deps);

  const server = createServer(async (req, res) => {
    // ponytail: echoes the request origin rather than a fixed allowlist — the daemon uses bearer tokens,
    // never cookies/credentials, and binds 127.0.0.1 only, so an echoed origin leaks nothing an attacker
    // page doesn't already need the admin token to exploit. Narrow to a real allowlist if that changes.
    applyCorsHeaders(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

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
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
