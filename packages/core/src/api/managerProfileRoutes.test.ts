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

const MISSION = 'Ship it, one pull request at a time.';

let server: Awaited<ReturnType<typeof startServer>>;
let harness: FakeHarness;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  harness = new FakeHarness();
  const managerRepository = new ManagerRepository(db);
  const sessions = new SessionService({
    db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0,
    missionOf: (sessionId) => managerRepository.get(sessionId)?.missionText,
  });
  const pulseScheduler = new PulseScheduler({ managers: managerRepository, sessions, bus });
  const managers = new ManagerService({
    managers: managerRepository, sessions, bus, scheduler: pulseScheduler,
    scapeImportStatusOf: (sessionId) => (sessionId === 'imported' ? 'edited_in_openfleet' : 'not_imported'),
  });
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals: new ApprovalService({ db, bus }), managers, pulseScheduler, bus,
    modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json',
  });
});
afterEach(() => server.close());

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${server.url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer admin' } });

const postJson = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });
const patchJson = (path: string, body: unknown) => api(path, { method: 'PATCH', body: JSON.stringify(body) });

async function createManager(): Promise<{ id: string }> {
  const response = await postJson('/api/sessions', {
    directory: '/tmp', name: 'Lead', emoji: '🧭', harness: 'fake', manager: { pulseSeconds: 600, childrenCap: 4, mission: MISSION },
  });
  return response.json();
}

async function createClosedManager(): Promise<{ id: string }> {
  const manager = await createManager();
  await postJson(`/api/sessions/${manager.id}/close`, {});
  return manager;
}

describe('PATCH /api/managers/:id', () => {
  it('saves the edited pulse, cap and mission, and answers the manager as it now is', async () => {
    const { id } = await createManager();

    const response = await patchJson(`/api/managers/${id}`, { pulseSeconds: 300, childrenCap: 8, mission: 'A new mission.' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sessionId: id, pulseSeconds: 300, childrenCap: 8, missionText: 'A new mission.' });
    const reread = await (await api(`/api/managers/${id}`)).json();
    expect(reread.manager).toMatchObject({ pulseSeconds: 300, childrenCap: 8, missionText: 'A new mission.' });
  });

  const modelOf = async (id: string): Promise<string | undefined> =>
    ((await (await api('/api/sessions')).json()) as { id: string; model?: string }[]).find((session) => session.id === id)?.model;

  it('changes the model of a closed manager, which nothing has to relaunch', async () => {
    const { id } = await createClosedManager();

    const response = await patchJson(`/api/managers/${id}`, { model: 'opus' });

    expect(response.status).toBe(200);
    expect(await modelOf(id)).toBe('opus');
  });

  it('changes the model of a live manager', async () => {
    const { id } = await createManager();

    const response = await patchJson(`/api/managers/${id}`, { model: 'opus' });

    expect(response.status).toBe(200);
    expect(await modelOf(id)).toBe('opus');
  });

  it('400s a model id that is not valid, and keeps the other fields as they were', async () => {
    const { id } = await createManager();

    const response = await patchJson(`/api/managers/${id}`, { model: 'not a model!', childrenCap: 8 });

    expect(response.status).toBe(400);
    expect((await (await api(`/api/managers/${id}`)).json()).manager.childrenCap).toBe(4);
  });

  it.each([
    ['a pulse of 0 seconds', { pulseSeconds: 0 }],
    ['a children cap above 64', { childrenCap: 65 }],
    ['an empty mission', { mission: '' }],
    ['no field at all', {}],
  ])('400s %s and changes nothing', async (_name, body) => {
    const { id } = await createManager();

    const response = await patchJson(`/api/managers/${id}`, body);

    expect(response.status).toBe(400);
    const reread = await (await api(`/api/managers/${id}`)).json();
    expect(reread.manager).toMatchObject({ pulseSeconds: 600, childrenCap: 4, missionText: MISSION });
  });

  it('404s a session that is no manager', async () => {
    const response = await patchJson('/api/managers/nope', { childrenCap: 2 });

    expect(response.status).toBe(404);
  });
});

describe('GET /api/managers/:id', () => {
  it('answers the manager with where it stands against a Scape re-import', async () => {
    const { id } = await createManager();

    const profile = await (await api(`/api/managers/${id}`)).json();

    expect(profile).toEqual({ manager: expect.objectContaining({ sessionId: id }), scapeImport: 'not_imported' });
  });

  it('404s a session that is no manager', async () => {
    expect((await api('/api/managers/nope')).status).toBe(404);
  });
});

describe('POST /api/sessions/:id/reopen with a mode', () => {
  async function reopenThenClose(id: string, mode: 'resume' | 'fresh'): Promise<string | undefined> {
    const response = await postJson(`/api/sessions/${id}/reopen`, { mode });
    expect(response.status).toBe(200);
    const conversationId = harness.launches.at(-1)?.cliSessionId;
    await postJson(`/api/sessions/${id}/close`, {});
    return conversationId;
  }

  it('reopens a closed manager fresh: a new conversation that starts from the mission', async () => {
    const { id } = await createClosedManager();
    const previousConversationId = await reopenThenClose(id, 'resume');

    const response = await postJson(`/api/sessions/${id}/reopen`, { mode: 'fresh' });

    expect(response.status).toBe(200);
    expect(harness.launches.at(-1)).toMatchObject({ resuming: false, seededPrompt: MISSION });
    expect(previousConversationId).toBeDefined();
    expect(harness.launches.at(-1)?.cliSessionId).not.toBe(previousConversationId);
  });

  it('goes back into the same conversation each time the mode is resume', async () => {
    const { id } = await createClosedManager();

    const firstConversationId = await reopenThenClose(id, 'resume');
    const secondConversationId = await reopenThenClose(id, 'resume');

    expect(firstConversationId).toBeDefined();
    expect(secondConversationId).toBe(firstConversationId);
  });

  it('409s a fresh reopen of a session that is no manager, with the catalogue code', async () => {
    const plain = await (await postJson('/api/sessions', { directory: '/tmp', name: 'G', harness: 'fake' })).json();
    await postJson(`/api/sessions/${plain.id}/close`, {});

    const response = await postJson(`/api/sessions/${plain.id}/reopen`, { mode: 'fresh' });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('not_a_manager');
  });

  it('400s a mode it does not know', async () => {
    const { id } = await createClosedManager();

    const response = await postJson(`/api/sessions/${id}/reopen`, { mode: 'sideways' });

    expect(response.status).toBe(400);
  });
});
