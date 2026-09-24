import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { EventBus } from '../events/eventBus.js';
import type { SessionService } from '../sessions/sessionService.js';

export function createWsHandler(deps: { bus: EventBus; sessions: SessionService; adminToken: string }) {
  const wss = new WebSocketServer({ noServer: true });
  deps.bus.subscribe((event) => {
    const payload = JSON.stringify(event);
    for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(payload);
  });
  wss.on('connection', (socket: WebSocket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as { type: string; sessionId: string; data?: string; cols?: number; rows?: number };
      if (message.type === 'input' && message.data !== undefined) deps.sessions.writeRaw(message.sessionId, message.data);
      if (message.type === 'resize' && message.cols && message.rows) deps.sessions.resize(message.sessionId, message.cols, message.rows);
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
