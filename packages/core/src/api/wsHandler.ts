import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ServerEvent } from '@openfleet/shared';
import { z } from 'zod';
import { WebSocketServer, type WebSocket } from 'ws';
import { ALLOWED_ORIGINS } from './allowedOrigins.js';
import type { ApprovalService } from '../governance/approvalService.js';
import type { EventBus } from '../events/eventBus.js';
import { tokensMatch } from '../ids.js';
import type { ManagerService } from '../managers/managerService.js';
import type { SessionService } from '../sessions/sessionService.js';

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
      console.error('ws: ignoring invalid client message', parsed.error.message);
      return undefined;
    }
    return parsed.data;
  } catch {
    console.error('ws: ignoring malformed client frame');
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
  // Closes every currently-connected client: a close frame first (so a cooperative UI sees a clean
  // close), then terminate() right behind it, since shutdown cannot wait on a slow or dead peer to ack.
  closeClients(): void;
}

export function createWsHandler(deps: { bus: EventBus; sessions: SessionService; approvals: ApprovalService; managers: ManagerService; adminToken: string }): WsHandler {
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
        console.error('ws: error handling client message', error);
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
        // ponytail: admin token travels in the query string because the browser WebSocket
        // constructor can't set an Authorization header; acceptable on a 127.0.0.1-only
        // daemon with a 0600 token file. Upgrade to a short-lived single-use ws-ticket
        // (issued over the already-authenticated REST surface) if this ever binds beyond
        // localhost or the desktop shell's webview turns out to persist URLs anywhere.
        const isAuthorized = url.pathname === '/ws' && tokensMatch(url.searchParams.get('token') ?? '', deps.adminToken);
        if (!isAuthorized) { socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      } catch (error) {
        console.error('ws: rejecting an unparsable upgrade request', error);
        socket.destroy();
      }
    },
    closeClients() {
      for (const client of wss.clients) {
        client.close();
        client.terminate();
      }
    },
  };
}
