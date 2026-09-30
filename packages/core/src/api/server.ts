import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { HTTP_STATUS_BY_KIND } from '@openfleet/shared';
import { describeError } from '../errors/describeError.js';
import type { EventBus } from '../events/eventBus.js';
import type { ApprovalService } from '../governance/approvalService.js';
import { tokensMatch } from '../ids.js';
import type { ManagerService } from '../managers/managerService.js';
import type { PulseScheduler } from '../managers/pulseScheduler.js';
import type { ModelTable } from '../models.js';
import type { DocsFolderService } from '../notes/docsFolderService.js';
import type { NoteRepository } from '../notes/noteRepository.js';
import type { NoteService } from '../notes/noteService.js';
import { PortInUseError } from './portInUseError.js';
import type { ProjectRepository } from '../projects/projectRepository.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { DataStoreRepository } from '../stores/dataStoreRepository.js';
import type { DataStoreService } from '../stores/dataStoreService.js';
import type { WorkingStateService } from '../workingState/workingStateService.js';
import { ALLOWED_ORIGINS } from './allowedOrigins.js';
import { registerDataStoreRoutes } from './dataStoreRoutes.js';
import type { SessionStartContext } from '../workingState/sessionStartContext.js';
import type { HandoverLedger } from '../workingState/handoverLedger.js';
import type { StopRefusal } from '../workingState/stopRefusal.js';
import { hooksHandler } from './hooksHandler.js';
import { registerNoteRoutes } from './noteRoutes.js';
import { registerProjectRoutes } from './projectRoutes.js';
import { registerRestRoutes } from './restHandlers.js';
import { decodeParams, json, readJson, redactedRequestPath, Router } from './router.js';
import { createWsHandler } from './wsHandler.js';
import { createWsTicketStore, type WsTicketStore } from './wsTicketStore.js';

const HOOK_PATH = /^\/hooks\/([^/]+)$/;

export interface ServerDeps {
  host: string; port: number; adminToken: string;
  sessions: SessionService; approvals: ApprovalService; bus: EventBus; modelTable: ModelTable; modelConfigPath: string;
  managers: ManagerService; pulseScheduler: PulseScheduler;
  mcp?: (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void>;
  wsCloseGraceMs?: number;
  // Overridable only so a test can inject a controllable clock/TTL; production always mints its own.
  wsTickets?: WsTicketStore;
  // The notes and data-store REST routes exist only when the daemon hands over their services.
  notes?: NoteService; noteRepo?: NoteRepository; docs?: DocsFolderService;
  stores?: DataStoreService; storeRepo?: DataStoreRepository; projects?: ProjectRepository;
  // The working-state route, event and snapshot fields exist only when the daemon hands over the service.
  workingStates?: WorkingStateService; workingStateMaxAgeMinutes?: number;
  // Without it every Stop is answered {}, as before the working state existed.
  stopRefusal?: StopRefusal;
  // Without it every SessionStart is answered {}, as before the working state existed.
  sessionStartContext?: SessionStartContext;
  // Without it no handover is recorded and the handovers route does not exist.
  handoverLedger?: HandoverLedger;
  // Without it the test-only routes (fake-output) do not exist.
  e2eRoutes?: boolean;
}

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, OPTIONS');
}

async function handleHookRequest(req: IncomingMessage, res: ServerResponse, hookToken: string, deps: ServerDeps): Promise<void> {
  if (!deps.sessions.byHookToken(hookToken)) return json(res, 200, {});
  const body = await readJson(req);
  await hooksHandler(deps)({ req, res, params: { hookToken }, body });
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  mcp: NonNullable<ServerDeps['mcp']>,
  sessions: SessionService,
): Promise<void> {
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!sessions.byMcpToken(bearer)) return json(res, 401, { error: 'unauthorized' });
  await mcp(req, res, await readJson(req));
}

/** Ends the request with a plain 500 when the error answer itself failed; a response already started is just ended. */
function answerLastResort(res: ServerResponse): void {
  try {
    if (res.headersSent) return void res.end();
    json(res, 500, { error: 'internal_error', kind: 'internal', retry: 'later', message: 'the daemon hit an unexpected error.' });
  } catch {
    res.destroy();
  }
}

export async function startServer(deps: ServerDeps): Promise<{ url: string; routes: { method: string; path: string }[]; close(): Promise<void> }> {
  const wsTickets = deps.wsTickets ?? createWsTicketStore();
  const router = new Router();
  // ponytail: unauthenticated readiness probe for CI/e2e webServer checks, which run before the admin token is known
  router.add('GET', '/health', ({ res }) => json(res, 200, { ok: true }));
  registerRestRoutes(router, { ...deps, wsTickets });
  if (deps.projects) registerProjectRoutes(router, deps.projects);
  if (deps.stores && deps.storeRepo) registerDataStoreRoutes(router, { stores: deps.stores, storeRepo: deps.storeRepo });
  if (deps.notes && deps.noteRepo && deps.docs) registerNoteRoutes(router, { notes: deps.notes, noteRepo: deps.noteRepo, docs: deps.docs });

  const server = createServer(async (req, res) => {
    applyCorsHeaders(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${deps.host}`);
    } catch {
      return json(res, 400, { error: 'invalid_url' });
    }

    try {
      // Both /hooks and /mcp resolve their token from the URL/header alone, before touching the body —
      // an unknown hook token or MCP bearer is answered without ever buffering the request into memory.
      const hookMatch = req.method === 'POST' ? HOOK_PATH.exec(url.pathname) : null;
      if (hookMatch) {
        const hookParams = decodeParams(['hookToken'], hookMatch);
        if (!hookParams) return json(res, 404, { error: 'not_found' });
        return await handleHookRequest(req, res, hookParams.hookToken!, deps);
      }
      if (url.pathname === '/mcp' && deps.mcp) return await handleMcpRequest(req, res, deps.mcp, deps.sessions);

      const match = router.match(req.method ?? 'GET', url.pathname);
      if (!match) return json(res, 404, { error: 'not_found' });
      const isProtected = url.pathname.startsWith('/api/');
      if (isProtected && !tokensMatch(req.headers.authorization ?? '', `Bearer ${deps.adminToken}`)) return json(res, 401, { error: 'unauthorized' });
      await match.handler({ req, res, params: match.params, body: await readJson(req) });
    } catch (error) {
      try {
        const envelope = describeError(error, { where: `${req.method ?? 'GET'} ${redactedRequestPath(req)} → 500` });
        const errorIdHeader: Record<string, string> = envelope.id ? { 'x-openfleet-error-id': envelope.id } : {};
        json(res, HTTP_STATUS_BY_KIND[envelope.kind], envelope, errorIdHeader);
      } catch {
        answerLastResort(res);
      }
    }
  });
  const ws = createWsHandler({ ...deps, wsTickets });
  server.on('upgrade', ws.upgrade);

  await new Promise<void>((resolve, reject) => {
    const rejectListenFailure = (error: NodeJS.ErrnoException) => {
      const isPortTaken = error.code === 'EADDRINUSE';
      reject(isPortTaken ? new PortInUseError(deps.port) : error);
    };
    server.once('error', rejectListenFailure);
    server.listen(deps.port, deps.host, () => { server.off('error', rejectListenFailure); resolve(); });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : deps.port;
  return {
    url: `http://${deps.host}:${port}`,
    routes: router.list(),
    close: () => {
      // closeAllConnections() only ever covered plain HTTP sockets — an upgraded WS connection is not one
      // of "server's" connections any more as far as node:http is concerned, so server.close() would wait
      // on it forever with the UI still open (MAJ-08/AUD-08). Close those out first, then the rest as before.
      ws.closeClients();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
