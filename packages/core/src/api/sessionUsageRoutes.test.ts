import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { UsageLedgerService } from '../usage/usageLedgerService.js';

const tempDirs = createTempDirTracker();
const todayUtc = new Date().toISOString().slice(0, 10);
const longAgo = '2026-01-15T10:00:00.000Z';
let daemon: Daemon;
let config: Config;
let ledger: UsageLedgerService;

interface TokenCounts { inputTokens: number; outputTokens: number }
interface ProjectDayCounts extends TokenCounts { dayUtc: string }

const authorized = () => ({ authorization: `Bearer ${config.adminToken}`, 'content-type': 'application/json' });
const post = async <T>(path: string, body: unknown) => (await (await fetch(`${daemon.server.url}${path}`, { method: 'POST', headers: authorized(), body: JSON.stringify(body) })).json()) as T;
const get = (path: string, headers: Record<string, string> = authorized()) => fetch(`${daemon.server.url}${path}`, { headers });

const createSession = async (fields: Record<string, unknown> = {}) =>
  (await post<{ id: string }>('/api/sessions', { directory: '/tmp', name: 'Gimli', harness: 'fake', model: 'opus', ...fields })).id;

const recordUsage = (sessionId: string, messageId: string, timestamp: string, tokens: TokenCounts) => {
  const line = JSON.stringify({ type: 'assistant', timestamp, message: { id: messageId, model: 'model-a', usage: { input_tokens: tokens.inputTokens, output_tokens: tokens.outputTokens } } });
  ledger.ingestTranscript({ sessionId, biller: 'subscription', transcriptText: line, billingCodeOf: () => sessionId });
};

beforeAll(async () => {
  config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-session-usage-'), OPENFLEET_PORT: '0', OPENFLEET_E2E: '1' });
  daemon = await startDaemon(config);
  ledger = new UsageLedgerService(daemon.db);
});
afterAll(async () => {
  await daemon.close();
  tempDirs.removeAll();
});

describe('GET /api/sessions/:id/usage on a booted daemon', () => {
  it('answers null for a session the ledger has no row for, never zero', async () => {
    const sessionId = await createSession();

    const response = await get(`/api/sessions/${sessionId}/usage`);

    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });

  it('sums the input and output tokens of the session over every day and model', async () => {
    const sessionId = await createSession();
    recordUsage(sessionId, 'm1', longAgo, { inputTokens: 1200, outputTokens: 300 });
    recordUsage(sessionId, 'm2', `${todayUtc}T08:00:00.000Z`, { inputTokens: 34, outputTokens: 5 });

    const body = await (await get(`/api/sessions/${sessionId}/usage`)).json();

    expect(body).toEqual({ inputTokens: 1234, outputTokens: 305 });
  });

  it('answers 404 for an unknown session', async () => {
    expect((await get('/api/sessions/unknown/usage')).status).toBe(404);
  });

  it('refuses a request without the admin token', async () => {
    const sessionId = await createSession();

    expect((await get(`/api/sessions/${sessionId}/usage`, {})).status).toBe(401);
  });

  it('leaves the hook token route untouched', async () => {
    const sessionId = await createSession();

    const body = (await (await get(`/api/sessions/${sessionId}/tokens`)).json()) as Record<string, unknown>;

    expect(Object.keys(body)).toEqual(['hookToken']);
  });
});

describe('GET /api/projects/:id/usage/today on a booted daemon', () => {
  const createProject = async (name: string) => (await post<{ id: string }>('/api/projects', { name })).id;

  it('answers null for a project whose sessions have no usage today', async () => {
    const projectId = await createProject('Quiet');
    const sessionId = await createSession({ projectId });
    recordUsage(sessionId, 'm1', longAgo, { inputTokens: 10, outputTokens: 10 });

    const body = await (await get(`/api/projects/${projectId}/usage/today`)).json();

    expect(body).toBeNull();
  });

  it('sums today of the sessions of the project only', async () => {
    const projectId = await createProject('Busy');
    const otherProjectId = await createProject('Elsewhere');
    const firstSession = await createSession({ projectId });
    const secondSession = await createSession({ projectId });
    const foreignSession = await createSession({ projectId: otherProjectId });
    recordUsage(firstSession, 'm1', `${todayUtc}T09:00:00.000Z`, { inputTokens: 100, outputTokens: 20 });
    recordUsage(firstSession, 'm2', longAgo, { inputTokens: 5000, outputTokens: 5000 });
    recordUsage(secondSession, 'm3', `${todayUtc}T10:00:00.000Z`, { inputTokens: 7, outputTokens: 3 });
    recordUsage(foreignSession, 'm4', `${todayUtc}T11:00:00.000Z`, { inputTokens: 999, outputTokens: 999 });

    const body = (await (await get(`/api/projects/${projectId}/usage/today`)).json()) as ProjectDayCounts;

    expect(body).toEqual({ dayUtc: todayUtc, inputTokens: 107, outputTokens: 23 });
  });

  it('answers 404 for an unknown project', async () => {
    expect((await get('/api/projects/unknown/usage/today')).status).toBe(404);
  });
});
