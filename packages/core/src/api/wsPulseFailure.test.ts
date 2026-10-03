import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { describeError } from '../errors/describeError.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

type Frame = Record<string, unknown>;

const PULSE_SECONDS = 1;
const openSockets: WebSocket[] = [];
let runningServer: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of openSockets.splice(0)) socket.close();
  await runningServer?.close();
  runningServer = undefined;
});

async function waitForFrame(frames: Frame[], matches: (frame: Frame) => boolean): Promise<Frame> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const found = frames.find(matches);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no matching frame among ${JSON.stringify(frames).slice(0, 800)}`);
}

describe('a failing pulse tick, over the websocket', () => {
  it('reaches a connected client as one error frame scoped to the manager, with a ref and no thrown detail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', describeError });
    const approvals = new ApprovalService({ db, bus });
    const managerRepo = new ManagerRepository(db);
    const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus, describeError });
    const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
    runningServer = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', bus });
    const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
    sessions.applyInput(manager.id, { kind: 'hook', event: { session_id: manager.id, hook_event_name: 'SessionStart' } as never });
    managerRepo.insert({ sessionId: manager.id, pulseSeconds: PULSE_SECONDS, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });
    const res = await fetch(`${runningServer.url}/api/ws-ticket`, { method: 'POST', headers: { authorization: 'Bearer admin' } });
    const { ticket } = (await res.json()) as { ticket: string };
    const socket = new WebSocket(`${runningServer.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
    openSockets.push(socket);
    const frames: Frame[] = [];
    socket.addEventListener('message', (message) => frames.push(JSON.parse(String(message.data))));
    await waitForFrame(frames, (frame) => frame.type === 'snapshot');
    vi.spyOn(sessions, 'sendMessage').mockImplementation(() => { throw new Error('sqlite write refused at /Users/someone/secret/db'); });

    pulseScheduler.onManagerCreated(managerRepo.get(manager.id)!);
    const errorFrame = await waitForFrame(frames, (frame) => frame.type === 'error');

    expect(errorFrame).toMatchObject({ sessionId: manager.id, error: { error: 'internal_error', kind: 'internal', retry: 'later', message: 'the daemon hit an unexpected error.' } });
    expect((errorFrame.error as { id: string }).id).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(errorFrame)).not.toContain('secret');
  });
});
