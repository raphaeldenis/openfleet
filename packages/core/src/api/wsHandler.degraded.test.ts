import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@openfleet/shared';
import { createDegradedRegistry, type DegradedRegistry } from '../process/degradedRegistry.js';

const connectedClients = vi.hoisted(() => new Set<unknown>());

vi.mock('ws', () => ({
  WebSocketServer: class {
    clients = connectedClients;
    on() {}
  },
}));

const { createWsHandler } = await import('./wsHandler.js');

const OPEN = 1;
const CLOSED = 3;
const FIVE_MINUTES_MS = 5 * 60_000;

type SendCallback = (error?: Error) => void;

function fakeClient() {
  const pendingCallbacks: SendCallback[] = [];
  const client = {
    OPEN,
    readyState: OPEN,
    send: (_payload: string, callback: SendCallback) => { pendingCallbacks.push(callback); },
  };
  return { client, pendingCallbacks };
}

describe('ws_broadcast_failed recovery', () => {
  let degraded: DegradedRegistry;
  let nowMs: number;
  let publish: (event: ServerEvent) => void;

  beforeEach(() => {
    connectedClients.clear();
    nowMs = Date.parse('2026-10-03T10:00:00Z');
    degraded = createDegradedRegistry({ clock: () => nowMs });
    let subscriber: ((event: ServerEvent) => void) | undefined;
    createWsHandler({
      bus: { subscribe: (listener: (event: ServerEvent) => void) => { subscriber ??= listener; return () => {}; } },
      degraded,
      clock: () => nowMs,
    } as unknown as Parameters<typeof createWsHandler>[0]);
    publish = (event) => subscriber!(event);
  });

  const probeEvent = { type: 'daemon.issues', issues: [] } as ServerEvent;
  const issueCodes = () => degraded.list().map((issue) => issue.code);

  it('keeps the issue after its own notification when the failing client closed before its write error arrived', () => {
    const { client, pendingCallbacks } = fakeClient();
    connectedClients.add(client);
    publish(probeEvent);

    client.readyState = CLOSED;
    pendingCallbacks.shift()!(new Error('write EPIPE'));

    expect(issueCodes()).toEqual(['ws_broadcast_failed']);
  });

  it('clears the issue once a broadcast is written to a client without error', () => {
    degraded.mark('ws_broadcast_failed', 'a client did not receive an event.');
    const { client, pendingCallbacks } = fakeClient();
    connectedClients.add(client);

    publish(probeEvent);
    pendingCallbacks.shift()!();

    expect(issueCodes()).toEqual([]);
  });

  it('keeps the issue while a broadcast only skips closed clients', () => {
    degraded.mark('ws_broadcast_failed', 'a client did not receive an event.');
    const { client } = fakeClient();
    client.readyState = CLOSED;
    connectedClients.add(client);

    publish(probeEvent);

    expect(issueCodes()).toEqual(['ws_broadcast_failed']);
  });

  it('keeps the issue on a broadcast with no client until the issue is older than the expiry window', () => {
    degraded.mark('ws_broadcast_failed', 'a client did not receive an event.');

    nowMs += FIVE_MINUTES_MS - 1;
    publish(probeEvent);

    expect(issueCodes()).toEqual(['ws_broadcast_failed']);
  });

  it('expires the issue on a broadcast with no client once it is older than the expiry window', () => {
    degraded.mark('ws_broadcast_failed', 'a client did not receive an event.');

    nowMs += FIVE_MINUTES_MS;
    publish(probeEvent);

    expect(issueCodes()).toEqual([]);
  });
});
