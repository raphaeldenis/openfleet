import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

let server: Awaited<ReturnType<typeof startServer>>;
let sessions: SessionService;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', bus });
});
afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.close();
  await server.close();
});

async function openClient(): Promise<{ socket: WebSocket; frames: Record<string, unknown>[] }> {
  const res = await fetch(`${server.url}/api/ws-ticket`, { method: 'POST', headers: { authorization: 'Bearer admin' } });
  const { ticket } = (await res.json()) as { ticket: string };
  const socket = new WebSocket(`${server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
  openSockets.push(socket);
  const frames: Record<string, unknown>[] = [];
  socket.addEventListener('message', (message) => frames.push(JSON.parse(String(message.data))));
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  await waitForFrame(frames, (frame) => frame.type === 'snapshot');
  return { socket, frames };
}

async function waitForFrame(frames: Record<string, unknown>[], matches: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = frames.find(matches);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no matching frame among ${JSON.stringify(frames).slice(0, 500)}`);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
const isError = (frame: Record<string, unknown>) => frame.type === 'error';
const createSession = () => sessions.create({ name: 'a', emoji: '🤖', directory: '/tmp', harness: 'fake' });

describe('WS client message errors', () => {
  it('T5: answers an input for a closed session with session_closed on that socket only', async () => {
    const session = await createSession();
    await sessions.close(session.id);
    const sender = await openClient();
    const bystander = await openClient();

    sender.socket.send(JSON.stringify({ type: 'input', sessionId: session.id, data: 'x' }));
    const event = await waitForFrame(sender.frames, isError);
    await settle();

    expect(event).toEqual({ type: 'error', sessionId: session.id, error: expect.objectContaining({ error: 'session_closed', kind: 'conflict', retry: 'never' }) });
    expect(bystander.frames.filter(isError)).toEqual([]);
  });

  it('answers an input for an unknown session with session_not_found', async () => {
    const { socket, frames } = await openClient();

    socket.send(JSON.stringify({ type: 'input', sessionId: 'nope', data: 'x' }));
    const event = await waitForFrame(frames, isError);

    expect(event).toEqual({ type: 'error', sessionId: 'nope', error: expect.objectContaining({ error: 'session_not_found', kind: 'not_found' }) });
  });

  it('answers a frame that is not JSON with invalid_body, without a session id, and keeps the socket open', async () => {
    const { socket, frames } = await openClient();

    socket.send('{not json');
    const event = await waitForFrame(frames, isError);

    expect(event).toEqual({ type: 'error', error: expect.objectContaining({ error: 'invalid_body', kind: 'invalid_request' }) });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('answers a JSON frame of the wrong shape with invalid_body, once', async () => {
    const { socket, frames } = await openClient();

    socket.send(JSON.stringify({ type: 'resize', sessionId: 's', cols: -1, rows: 'x' }));
    await waitForFrame(frames, isError);
    await settle();

    expect(frames.filter(isError)).toHaveLength(1);
    expect(frames.find(isError)).toMatchObject({ error: { error: 'invalid_body' } });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('hostile 5: a 1 MiB session id in an input frame yields one small error event and the socket stays open', async () => {
    const { socket, frames } = await openClient();
    const hugeSessionId = 'x'.repeat(1024 * 1024);

    socket.send(JSON.stringify({ type: 'input', sessionId: hugeSessionId, data: 'x' }));
    await waitForFrame(frames, isError);
    await settle();

    const errors = frames.filter(isError);
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0]).length).toBeLessThan(4096);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });
});
