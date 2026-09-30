import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { OpenFleetError, type ServerEvent } from '@openfleet/shared';
import { z } from 'zod';
import { WebSocketServer, type WebSocket } from 'ws';
import { ALLOWED_ORIGINS } from './allowedOrigins.js';
import { describeError } from '../errors/describeError.js';
import type { ApprovalService } from '../governance/approvalService.js';
import type { EventBus } from '../events/eventBus.js';
import { log } from '../logger.js';
import type { ManagerService } from '../managers/managerService.js';
import type { DegradedRegistry } from '../process/degradedRegistry.js';
import { SessionClosedError, type SessionService } from '../sessions/sessionService.js';
import { DEFAULT_WORKING_STATE_MAX_AGE_MINUTES } from '../workingState/workingStateSettings.js';
import type { WorkingStateService } from '../workingState/workingStateService.js';
import type { WsTicketStore } from './wsTicketStore.js';

const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), sessionId: z.string(), data: z.string() }),
  z.object({ type: z.literal('resize'), sessionId: z.string(), cols: z.number().int().positive(), rows: z.number().int().positive() }),
  z.object({ type: z.literal('attach'), sessionId: z.string() }),
]);
type ClientMessage = z.infer<typeof ClientMessageSchema>;

const MAX_ECHOED_SESSION_ID_CHARS = 128;

function parseClientFrame(raw: unknown): unknown {
  try {
    return JSON.parse(String(raw));
  } catch {
    throw new OpenFleetError('invalid_body', 'the message is not valid JSON.');
  }
}

// A session id longer than any real one is never echoed back: the answer stays small whatever the client sent.
function echoableSessionId(frame: unknown): string | undefined {
  const sessionId = (frame as { sessionId?: unknown } | null | undefined)?.sessionId;
  const isEchoable = typeof sessionId === 'string' && sessionId.length <= MAX_ECHOED_SESSION_ID_CHARS;
  return isEchoable ? sessionId : undefined;
}

/** Best effort: a socket that is closing or whose send throws never stops the caller. Returns true when the send threw. */
function sendBestEffort(socket: WebSocket, payload: string): boolean {
  if (socket.readyState !== socket.OPEN) return false;
  try {
    socket.send(payload);
    return false;
  } catch (error) {
    log('warn', 'ws: send failed', { code: (error as { code?: string }).code });
    return true;
  }
}

function send(socket: WebSocket, event: ServerEvent): void {
  sendBestEffort(socket, JSON.stringify(event));
}

function replyWithError(socket: WebSocket, error: unknown, sessionId: string | undefined): void {
  const envelope = describeError(error, { sessionId, where: 'ws client message' });
  send(socket, { type: 'error', ...(sessionId !== undefined && { sessionId }), error: envelope });
}

function assertSessionAcceptsInput(sessions: SessionService, sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) throw new OpenFleetError('session_not_found', 'the session does not exist.');
  if (session.state === 'closed') throw new SessionClosedError(sessionId);
}

function handleClientMessage(socket: WebSocket, message: ClientMessage, deps: { sessions: SessionService }): void {
  switch (message.type) {
    case 'input':
      assertSessionAcceptsInput(deps.sessions, message.sessionId);
      return deps.sessions.writeRaw(message.sessionId, message.data);
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

export function createWsHandler(deps: { bus: EventBus; sessions: SessionService; approvals: ApprovalService; managers: ManagerService; wsTickets: WsTicketStore; wsCloseGraceMs?: number; workingStates?: WorkingStateService; workingStateMaxAgeMinutes?: number; degraded?: DegradedRegistry }): WsHandler {
  const wss = new WebSocketServer({ noServer: true });
  // A broadcast runs inside the session pipeline (the bus is synchronous): one bad client never stops the others or the caller.
  const broadcast = (event: ServerEvent) => {
    const payload = JSON.stringify(event);
    const clients = [...wss.clients];
    const sendFailures = clients.filter((client) => sendBestEffort(client, payload)).length;
    if (sendFailures > 0) deps.degraded?.mark('ws_broadcast_failed', 'a client did not receive an event.');
    else if (clients.length > 0) deps.degraded?.clear('ws_broadcast_failed');
  };
  deps.bus.subscribe(broadcast);
  deps.degraded?.onChange((issues) => broadcast({ type: 'daemon.issues', issues }));

  const broadcastWorkingStateOf = (sessionId: string | undefined) => {
    const isClosed = sessionId ? deps.sessions.get(sessionId)?.state === 'closed' : false;
    const state = sessionId && !isClosed ? deps.workingStates?.get(sessionId) : undefined;
    if (state) broadcast({ type: 'session.working_state', state });
  };
  deps.workingStates?.onUpdate((state) => broadcast({ type: 'session.working_state', state }));
  // A child spawned, closed or reopened moves its parent's fleetChangedAt, so the parent's state goes out again.
  deps.bus.subscribe((event) => {
    if (event.type === 'session.created') broadcastWorkingStateOf(event.session.parentId);
    if (event.type === 'session.closed') broadcastWorkingStateOf(deps.sessions.get(event.sessionId)?.parentId);
    if (event.type === 'session.reopened') broadcastWorkingStateOf(deps.sessions.get(event.sessionId)?.parentId);
  });
  const openSessionWorkingStates = () => deps.sessions.list()
    .filter((session) => session.state !== 'closed')
    .flatMap((session) => deps.workingStates?.get(session.id) ?? []);
  const workingStateSnapshotFields = () => deps.workingStates ? {
    workingStates: openSessionWorkingStates(),
    workingStateMaxAgeMinutes: deps.workingStateMaxAgeMinutes ?? DEFAULT_WORKING_STATE_MAX_AGE_MINUTES,
    workingStateMaxBytes: deps.workingStates.maxBytes,
  } : {};
  wss.on('connection', (socket: WebSocket) => {
    // Sent synchronously, before any broadcast event can reach this socket, so the client always has a
    // baseline to upsert onto — a session created in the connect/open race just arrives twice, harmlessly.
    send(socket, {
      type: 'snapshot', sessions: deps.sessions.list(), approvals: deps.approvals.listPending(), managers: deps.managers.listViews(),
      ...workingStateSnapshotFields(),
      ...(deps.degraded && { daemonIssues: deps.degraded.list() }),
    });
    socket.on('message', (raw) => {
      let frame: unknown;
      try {
        frame = parseClientFrame(raw);
        handleClientMessage(socket, ClientMessageSchema.parse(frame), deps);
      } catch (error) {
        replyWithError(socket, error, echoableSessionId(frame));
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
