import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ServerEvent } from '@openfleet/shared';
import { z } from 'zod';
import { WebSocketServer, type WebSocket } from 'ws';
import { ALLOWED_ORIGINS } from './allowedOrigins.js';
import type { ApprovalService } from '../governance/approvalService.js';
import type { EventBus } from '../events/eventBus.js';
import { log } from '../logger.js';
import type { ManagerService } from '../managers/managerService.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { WsTicketStore } from './wsTicketStore.js';

const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), sessionId: z.string(), data: z.string() }),
  z.object({ type: z.literal('resize'), sessionId: z.string(), cols: z.number().int().positive(), rows: z.number().int().positive() }),
  z.object({ type: z.literal('attach'), sessionId: z.string() }),
]);
type ClientMessage = z.infer<typeof ClientMessageSchema>;

function parseClientMessage(raw: unknown): ClientMessage | undefined {
  try {
    const parsed = ClientMessageSchema.safeParse(JSON.parse(String(raw)));
    if (!parsed.success) {
      log('error', 'ws: ignoring invalid client message', parsed.error.message);
      return undefined;
    }
    return parsed.data;
  } catch {
    log('error', 'ws: ignoring malformed client frame');
    return undefined;
  }
}

function send(socket: WebSocket, event: ServerEvent): void {
  socket.send(JSON.stringify(event));
}

function handleClientMessage(socket: WebSocket, message: ClientMessage, deps: { sessions: SessionService }): void {
  switch (message.type) {
    case 'input': return deps.sessions.writeRaw(message.sessionId, message.data);
    case 'resize': return deps.sessions.resize(message.sessionId, message.cols, message.rows);
    case 'attach': return send(socket, { type: 'session.replay', sessionId: message.sessionId, data: deps.sessions.recentOutput(message.sessionId) });
  }
}

export interface WsHandler {
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  // Closes every currently-connected client: a close frame first (so a cooperative UI gets a clean 1001
  // going-away close), then a short grace period for that handshake to land, after which any client still
  // open — a dead or hostile peer that never acks — is force-terminated so shutdown can never hang on it.
  closeClients(): void;
}

const DEFAULT_WS_CLOSE_GRACE_MS = 250;

export function createWsHandler(deps: { bus: EventBus; sessions: SessionService; approvals: ApprovalService; managers: ManagerService; wsTickets: WsTicketStore; wsCloseGraceMs?: number }): WsHandler {
  const wss = new WebSocketServer({ noServer: true });
  deps.bus.subscribe((event) => {
    const payload = JSON.stringify(event);
    for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(payload);
  });
  wss.on('connection', (socket: WebSocket) => {
    // Sent synchronously, before any broadcast event can reach this socket, so the client always has a
    // baseline to upsert onto — a session created in the connect/open race just arrives twice, harmlessly.
    send(socket, { type: 'snapshot', sessions: deps.sessions.list(), approvals: deps.approvals.listPending(), managers: deps.managers.listViews() });
    socket.on('message', (raw) => {
      const message = parseClientMessage(raw);
      if (!message) return;
      try {
        handleClientMessage(socket, message, deps);
      } catch (error) {
        log('error', 'ws: error handling client message', error);
      }
    });
  });

  return {
    upgrade(req, socket, head) {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        // A browser sends Origin on every WebSocket handshake; a non-browser client (the audit probes, a
        // future native tool) sends none at all. Only a *foreign* Origin is refused — the browser is the
        // one context where a page the admin token never touched could still open this socket cross-site.
        const origin = req.headers.origin;
        if (origin && !ALLOWED_ORIGINS.has(origin)) { socket.destroy(); return; }
        // AUD-27: the browser WebSocket constructor can't set an Authorization header, so some credential
        // still has to travel in the query string — but no longer the long-lived admin token, which used to
        // land in the console (URL and all) on every failed reconnect. A ticket is minted over the
        // already-authenticated REST surface (POST /api/ws-ticket), is single-use, and expires in seconds:
        // whatever ends up logging it gets a value worth nothing by the time anyone could reuse it.
        const ticket = url.searchParams.get('ticket');
        const isAuthorized = url.pathname === '/ws' && ticket !== null && deps.wsTickets.consume(ticket);
        if (!isAuthorized) { socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      } catch (error) {
        // Never the error object itself: node:url's own TypeError carries the full request URL — token
        // and all — on its .input property, which a naive `log(..., error)` would print in full.
        log('error', 'ws: rejecting an unparsable upgrade request', { code: (error as { code?: string }).code });
        socket.destroy();
      }
    },
    closeClients() {
      const clients = [...wss.clients];
      for (const client of clients) client.close(1001, 'daemon shutting down');
      const graceTimer = setTimeout(() => {
        for (const client of clients) if (client.readyState !== client.CLOSED) client.terminate();
      }, deps.wsCloseGraceMs ?? DEFAULT_WS_CLOSE_GRACE_MS);
      graceTimer.unref?.();
    },
  };
}
