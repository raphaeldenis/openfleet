import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ServerEvent } from '@openfleet/shared';
import { z } from 'zod';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ApprovalService } from '../governance/approvalService.js';
import type { EventBus } from '../events/eventBus.js';
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

export function createWsHandler(deps: { bus: EventBus; sessions: SessionService; approvals: ApprovalService; managers: ManagerService; adminToken: string }) {
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

  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // ponytail: admin token travels in the query string because the browser WebSocket
    // constructor can't set an Authorization header; acceptable on a 127.0.0.1-only
    // daemon with a 0600 token file. Upgrade to a short-lived single-use ws-ticket
    // (issued over the already-authenticated REST surface) if this ever binds beyond
    // localhost or the desktop shell's webview turns out to persist URLs anywhere.
    const isAuthorized = url.pathname === '/ws' && url.searchParams.get('token') === deps.adminToken;
    if (!isAuthorized) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
}
