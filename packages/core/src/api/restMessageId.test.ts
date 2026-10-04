import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

let server: Awaited<ReturnType<typeof startServer>>;
let sessions: SessionService;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json' });
});

afterEach(async () => {
  await server.close();
  await sessions.closeAll();
});

const postJson = (path: string, body: unknown) =>
  fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer admin' }, body: JSON.stringify(body) });

const createSession = async () => ((await (await postJson('/api/sessions', { directory: '/tmp', name: 'G', harness: 'fake', model: 'opus' })).json()) as { id: string }).id;

describe('POST /api/sessions/:id/messages with a client messageId', () => {
  it('sends the message once when the same messageId is posted twice, and answers the retry with the first result', async () => {
    const sessionId = await createSession();
    const messageId = randomUUID();

    const first = await postJson(`/api/sessions/${sessionId}/messages`, { body: 'approve staging', messageId });
    const retry = await postJson(`/api/sessions/${sessionId}/messages`, { body: 'approve staging', messageId });

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(await first.json());
    expect(sessions.queuedMessageCount(sessionId)).toBe(1);
  });

  it('answers the sent messageId back so the client can follow its delivery', async () => {
    const sessionId = await createSession();
    const messageId = randomUUID();

    const response = await postJson(`/api/sessions/${sessionId}/messages`, { body: 'hello', messageId });

    expect(await response.json()).toMatchObject({ messageId });
  });

  it('refuses a messageId that is not a uuid', async () => {
    const sessionId = await createSession();

    const response = await postJson(`/api/sessions/${sessionId}/messages`, { body: 'hello', messageId: 'not-a-uuid' });

    expect(response.status).toBe(400);
  });

  it('still sends two messages when no messageId is given', async () => {
    const sessionId = await createSession();

    const first = (await (await postJson(`/api/sessions/${sessionId}/messages`, { body: 'one' })).json()) as { messageId: string };
    const second = (await (await postJson(`/api/sessions/${sessionId}/messages`, { body: 'one' })).json()) as { messageId: string };

    expect(second.messageId).not.toBe(first.messageId);
  });
});
