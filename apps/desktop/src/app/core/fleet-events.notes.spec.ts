import type { NoteChangeEvent } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetEventsService } from './fleet-events.service';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  private readonly listeners: Record<string, ((event: { data: string }) => void)[]> = {};
  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  dispatchMessage(payload: unknown): void {
    for (const listener of this.listeners['message'] ?? []) listener({ data: JSON.stringify(payload) });
  }
}

describe('FleetEventsService note events', () => {
  let service: FleetEventsService;
  let received: NoteChangeEvent[];

  beforeEach(async () => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ticket: 't' }) }));
    service = new FleetEventsService();
    received = [];
    service.noteChanges.subscribe((change) => received.push(change));
    await service.connect();
  });
  afterEach(() => vi.unstubAllGlobals());

  const socket = () => FakeWebSocket.instances[0]!;

  it('announces a created, an updated and a deleted note as they arrive, in order', () => {
    const created: NoteChangeEvent = { type: 'note.created', noteId: 'n1', projectId: 'p1', rev: 1 };
    const changed: NoteChangeEvent = { type: 'note.updated', noteId: 'n1', projectId: 'p1', rev: 2, source: 'mcp' };
    const deleted: NoteChangeEvent = { type: 'note.deleted', noteId: 'n1', projectId: 'p1' };

    for (const event of [created, changed, deleted]) socket().dispatchMessage(event);

    expect(received).toEqual([created, changed, deleted]);
  });

  it('announces nothing for the other events', () => {
    socket().dispatchMessage({ type: 'session.reopened', sessionId: 's1' });
    socket().dispatchMessage({ type: 'note.something_from_a_newer_daemon', noteId: 'n1' });

    expect(received).toEqual([]);
  });

  it('does not put notes in the snapshot-fed state: a note event leaves sessions and managers untouched', () => {
    socket().dispatchMessage({ type: 'note.updated', noteId: 'n1', projectId: 'p1', rev: 2, source: 'rest' });

    expect(service.sessions()).toEqual([]);
    expect(service.managers()).toEqual([]);
  });
});
