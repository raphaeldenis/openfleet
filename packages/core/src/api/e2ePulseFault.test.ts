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
const FRAME_TIMEOUT_MS = 8000;
const openSockets: WebSocket[] = [];
let runningServer: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of openSockets.splice(0)) socket.close();
  await runningServer?.close();
  runningServer = undefined;
});

async function waitForFrame(frames: Frame[], matches: (frame: Frame) => boolean): Promise<Frame> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const found = frames.find(matches);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no matching frame among ${JSON.stringify(frames).slice(0, 800)}`);
}

async function startDaemonWithAManager(options: { e2eRoutes: boolean }) {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', describeError });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus, describeError });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  runningServer = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', bus, e2eRoutes: options.e2eRoutes });
  const manager = await sessions.create({ directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake' });
  sessions.applyInput(manager.id, { kind: 'hook', event: { session_id: manager.id, hook_event_name: 'SessionStart' } as never });
  managerRepo.insert({ sessionId: manager.id, pulseSeconds: PULSE_SECONDS, childrenCap: 1, missionText: 'x', createdAt: new Date().toISOString() });
  const failNextPulses = (managerId: string, body: unknown) =>
    fetch(`${runningServer!.url}/api/managers/${managerId}/fail-next-pulses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer admin' }, body: JSON.stringify(body) });
  const listenToFrames = async () => {
    const res = await fetch(`${runningServer!.url}/api/ws-ticket`, { method: 'POST', headers: { authorization: 'Bearer admin' } });
    const { ticket } = (await res.json()) as { ticket: string };
    const socket = new WebSocket(`${runningServer!.url.replace('http', 'ws')}/ws?ticket=${ticket}`);
    openSockets.push(socket);
    const frames: Frame[] = [];
    socket.addEventListener('message', (message) => frames.push(JSON.parse(String(message.data))));
    await waitForFrame(frames, (frame) => frame.type === 'snapshot');
    return frames;
  };
  const armManager = () => pulseScheduler.onManagerCreated(managerRepo.get(manager.id)!);
  return { manager, failNextPulses, listenToFrames, armManager };
}

describe('the e2e fault hook of the pulse', () => {
  it('fails the requested number of ticks, announces the streak once, then pulses again', async () => {
    const { manager, failNextPulses, listenToFrames, armManager } = await startDaemonWithAManager({ e2eRoutes: true });
    const frames = await listenToFrames();

    const response = await failNextPulses(manager.id, { count: 2 });
    armManager();
    await waitForFrame(frames, (frame) => frame.type === 'manager.pulsed');

    const errorFrames = frames.filter((frame) => frame.type === 'error');
    expect(response.status).toBe(200);
    expect(errorFrames).toHaveLength(1);
    expect(errorFrames[0]).toMatchObject({ sessionId: manager.id, error: { error: 'internal_error', kind: 'internal' } });
  });

  it('answers 404 for a manager that does not exist', async () => {
    const { failNextPulses } = await startDaemonWithAManager({ e2eRoutes: true });

    const response = await failNextPulses('no-such-manager', { count: 1 });

    expect(response.status).toBe(404);
  });

  it('answers 400 for a count that is not a positive whole number', async () => {
    const { manager, failNextPulses } = await startDaemonWithAManager({ e2eRoutes: true });

    const response = await failNextPulses(manager.id, { count: 0 });

    expect(response.status).toBe(400);
  });

  it('does not exist when the e2e routes are off', async () => {
    const { manager, failNextPulses, listenToFrames, armManager } = await startDaemonWithAManager({ e2eRoutes: false });
    const frames = await listenToFrames();

    const response = await failNextPulses(manager.id, { count: 1 });
    armManager();
    await waitForFrame(frames, (frame) => frame.type === 'manager.pulsed');

    expect(response.status).toBe(404);
    expect(frames.filter((frame) => frame.type === 'error')).toEqual([]);
  });
});
