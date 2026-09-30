import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { InvalidJsonBodyError, Router } from './router.js';
import { startServer } from './server.js';

const ADMIN_TOKEN = 'admin';
const ERROR_MESSAGE = 'boom-marker-4242';
const ID_PATTERN = /^[0-9a-f]{8}$/;

let server: Awaited<ReturnType<typeof startServer>>;
let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: ADMIN_TOKEN, sessions, approvals, managers, pulseScheduler, bus,
    modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', e2eRoutes: true,
  });
});
afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
});

const concretePath = (pattern: string) => pattern.replace(/:[a-zA-Z]+/g, 'some-id');

function makeEveryHandlerThrow(error: unknown) {
  vi.spyOn(Router.prototype, 'match').mockReturnValue({ handler: () => { throw error; }, params: {} });
}

async function callRoute({ method, path }: { method: string; path: string }) {
  return fetch(`${server.url}${concretePath(path)}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : '{}',
  });
}

describe('T2: a handler that throws on any route', () => {
  it('lists the routes the contract runs on', () => {
    expect(server.routes.length).toBeGreaterThan(10);
  });

  it('answers 500 internal_error with kind, retry and an 8-hex id on every route', async () => {
    makeEveryHandlerThrow(new Error(ERROR_MESSAGE));
    const routes = server.routes.filter(({ path }) => path.startsWith('/api/'));
    const answers = await Promise.all(routes.map(async (route) => {
      const response = await callRoute(route);
      return { route, status: response.status, body: await response.json() as Record<string, unknown> };
    }));
    const failures = answers.filter(({ status, body }) =>
      status !== 500 || body.error !== 'internal_error' || body.kind !== 'internal' || body.retry !== 'later' || !ID_PATTERN.test(String(body.id)));
    expect(failures).toEqual([]);
  });

  it('puts the same id in the response header, the body and the logged line', async () => {
    makeEveryHandlerThrow(new Error(ERROR_MESSAGE));
    const response = await callRoute({ method: 'GET', path: '/api/sessions' });
    const { id } = await response.json() as { id: string };
    expect(response.headers.get('x-openfleet-error-id')).toBe(id);
    const loggedLines: string[] = errorLog.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(loggedLines.filter((line) => line.includes(id))).toHaveLength(1);
  });

  it('logs exactly one error line per failed request', async () => {
    makeEveryHandlerThrow(new Error(ERROR_MESSAGE));
    await callRoute({ method: 'GET', path: '/api/sessions' });
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it('keeps the error message and the stack out of the body', async () => {
    makeEveryHandlerThrow(new Error(ERROR_MESSAGE));
    const text = await (await callRoute({ method: 'GET', path: '/api/sessions' })).text();
    expect(text).not.toContain(ERROR_MESSAGE);
    expect(text).not.toContain('    at ');
  });

  it('keeps the request path in the logged line', async () => {
    makeEveryHandlerThrow(new Error(ERROR_MESSAGE));
    await callRoute({ method: 'GET', path: '/api/sessions' });
    expect(String(errorLog.mock.calls[0]![0])).toContain('GET /api/sessions');
  });
});

describe('the REST catch-all keeps its existing wire values', () => {
  it('answers a typed domain error with its code, its kind and no id or header', async () => {
    makeEveryHandlerThrow(new InvalidJsonBodyError('Unexpected token }'));
    const response = await callRoute({ method: 'POST', path: '/api/sessions' });
    expect({ status: response.status, header: response.headers.get('x-openfleet-error-id'), body: await response.json() }).toEqual({
      status: 400,
      header: null,
      body: { error: 'invalid_json', kind: 'invalid_request', retry: 'never', message: expect.any(String), detail: 'Unexpected token }' },
    });
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('answers a zod failure 400 invalid_body with the zod message as detail', async () => {
    const response = await fetch(`${server.url}/api/sessions`, {
      method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' }, body: '{"name":5}',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_body', kind: 'invalid_request', retry: 'never', detail: expect.any(String) });
  });

  it('answers an oversized body 413 payload_too_large with kind too_large', async () => {
    const response = await fetch(`${server.url}/api/sessions`, {
      method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 1) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'payload_too_large', kind: 'too_large', retry: 'never' });
  });
});
