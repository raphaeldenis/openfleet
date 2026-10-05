import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ApprovalService } from '../governance/approvalService.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

const AGENT_MESSAGE = 'agent: please check the build';

let server: Awaited<ReturnType<typeof startServer>>;
let harness: FakeHarness;
let sessions: SessionService;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  harness = new FakeHarness();
  const managerRepository = new ManagerRepository(db);
  sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const pulseScheduler = new PulseScheduler({ managers: managerRepository, sessions, bus });
  const managers = new ManagerService({ managers: managerRepository, sessions, bus, scheduler: pulseScheduler, scapeImportStatusOf: () => 'not_imported' });
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals: new ApprovalService({ db, bus }), managers, pulseScheduler, bus,
    modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json',
  });
});
afterEach(() => server.close());

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer admin' } });
const postJson = (path: string, body: unknown = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

async function sessionWithMessageHeldBehindDraft() {
  const created = await postJson('/api/sessions', { directory: '/tmp', name: 'G', emoji: '🤖', harness: 'fake' });
  const { id } = await created.json() as { id: string };
  sessions.applyInput(id, { kind: 'hook', event: { session_id: id, hook_event_name: 'SessionStart' } as never });
  await postJson(`/api/sessions/${id}/input`, { data: 'hi' });
  const sent = await postJson(`/api/sessions/${id}/messages`, { body: AGENT_MESSAGE });
  const { messageId } = await sent.json() as { messageId: string };
  return { id, messageId };
}

const wasTypedIntoThePrompt = () => harness.handles[0]!.written.some((chunk) => chunk.includes(AGENT_MESSAGE));

describe('held messages API', () => {
  it('answers the message the send reported as held, with the reason it waits', async () => {
    const { id, messageId } = await sessionWithMessageHeldBehindDraft();

    const response = await api(`/api/sessions/${id}/held-messages`);

    expect(await response.json()).toEqual([expect.objectContaining({ messageId, heldFor: 'human_draft', body: expect.stringContaining(AGENT_MESSAGE) })]);
  });

  it('discards a held message so it is never typed', async () => {
    const { id, messageId } = await sessionWithMessageHeldBehindDraft();

    const discarded = await postJson(`/api/sessions/${id}/held-messages/${messageId}/discard`);
    await postJson(`/api/sessions/${id}/input`, { data: '\r' });

    expect(discarded.status).toBe(200);
    expect(await (await api(`/api/sessions/${id}/held-messages`)).json()).toEqual([]);
    expect(wasTypedIntoThePrompt()).toBe(false);
  });

  it('releases a held message so it is typed behind the draft', async () => {
    const { id, messageId } = await sessionWithMessageHeldBehindDraft();

    const released = await postJson(`/api/sessions/${id}/held-messages/${messageId}/release`);

    expect(released.status).toBe(200);
    expect(wasTypedIntoThePrompt()).toBe(true);
  });

  it('answers 404 for a message that is not held', async () => {
    const { id } = await sessionWithMessageHeldBehindDraft();

    const discarded = await postJson(`/api/sessions/${id}/held-messages/unknown/discard`);
    const released = await postJson(`/api/sessions/${id}/held-messages/unknown/release`);

    expect([discarded.status, released.status]).toEqual([404, 404]);
  });
});
