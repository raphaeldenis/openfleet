import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { SilentBlockDetector } from '../governance/silentBlockDetector.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

let server: Awaited<ReturnType<typeof startServer>>;
let bus: EventBus;
let fireSilentBlockTimers: () => void;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const db = openDatabase(':memory:');
  bus = new EventBus();
  const pendingTimers = new Set<() => void>();
  fireSilentBlockTimers = () => { for (const timer of [...pendingTimers]) { pendingTimers.delete(timer); timer(); } };
  const silentBlocks = new SilentBlockDetector({
    thresholdMinutes: 5,
    schedule: (callback) => { pendingTimers.add(callback); return () => { pendingTimers.delete(callback); }; },
    onChange: (blocks) => bus.emit({ type: 'permission.silent_blocks', blocks }),
  });
  bus.subscribe((event) => silentBlocks.handle(event));
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', bus, silentBlocks });
});
afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.close();
  await server.close();
  vi.restoreAllMocks();
});

async function openClient(): Promise<{ frames: Record<string, unknown>[] }> {
  const res = await fetch(`${server.url}/api/ws-ticket`, { method: 'POST', headers: { authorization: 'Bearer admin' } });
  const { ticket } = (await res.json()) as { ticket: string };
  const socket = new WebSocket(`${server.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
  openSockets.push(socket);
  const frames: Record<string, unknown>[] = [];
  socket.addEventListener('message', (message) => frames.push(JSON.parse(String(message.data))));
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  await waitForFrame(frames, (frame) => frame.type === 'snapshot');
  return { frames };
}

async function waitForFrame(frames: Record<string, unknown>[], matches: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = frames.find(matches);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no matching frame among ${JSON.stringify(frames).slice(0, 500)}`);
}

const waitsOnPrompt = () => bus.emit({ type: 'session.state', sessionId: 's1', state: 'waiting_permission', stateSince: '2026-10-04T10:00:00.000Z' });

describe('silent blocks over the WebSocket', () => {
  it('puts an empty list in the snapshot while no prompt is silent', async () => {
    const { frames } = await openClient();

    expect(frames.find((frame) => frame.type === 'snapshot')).toMatchObject({ silentBlocks: [] });
  });

  it('broadcasts the list when a prompt passes the threshold, and the empty list when it is decided', async () => {
    const { frames } = await openClient();

    waitsOnPrompt();
    fireSilentBlockTimers();
    await waitForFrame(frames, (frame) => frame.type === 'permission.silent_blocks' && (frame.blocks as unknown[]).length === 1);
    bus.emit({ type: 'session.state', sessionId: 's1', state: 'generating', stateSince: '2026-10-04T10:06:00.000Z' });

    await waitForFrame(frames, (frame) => frame.type === 'permission.silent_blocks' && (frame.blocks as unknown[]).length === 0);
  });

  it('puts the silent block in the snapshot of a client that connects afterwards', async () => {
    waitsOnPrompt();
    fireSilentBlockTimers();

    const { frames } = await openClient();

    expect(frames.find((frame) => frame.type === 'snapshot')).toMatchObject({ silentBlocks: [{ sessionId: 's1', waitingSince: '2026-10-04T10:00:00.000Z' }] });
  });
});
