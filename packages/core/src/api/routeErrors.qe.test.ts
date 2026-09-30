import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { forceNdjsonLogging } from '../forceNdjsonLogging.testkit.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { newId } from '../ids.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { SessionService } from '../sessions/sessionService.js';
import { DataStoreRepository } from '../stores/dataStoreRepository.js';
import { DataStoreService } from '../stores/dataStoreService.js';
import { startServer } from './server.js';

const ADMIN_TOKEN = 'admin-token-of-the-day';
const ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' };
const JSON_ONLY = { 'content-type': 'application/json' };
const OVER_THE_BODY_CAP = JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 1) });

let server: Awaited<ReturnType<typeof startServer>>;
let sessions: SessionService;
let scratch: string;
let streamingMcpHandler: (res: import('node:http').ServerResponse) => void;
let storeId: string;
const logWrites = () => [console.log, console.info, console.warn, console.error].flatMap((spy) => (spy as unknown as { mock: { calls: unknown[][] } }).mock.calls);

beforeEach(async () => {
  forceNdjsonLogging();
  for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
  scratch = mkdtempSync(join(tmpdir(), 'of-qe-routes-'));
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const projects = new ProjectRepository(db);
  projects.insert({ id: 'p1', name: 'One', docsFolderPath: null, createdAt: 't0' });
  projects.insert({ id: 'p2', name: 'Two', docsFolderPath: null, createdAt: 't0' });
  const storeRepo = new DataStoreRepository(db);
  const stores = new DataStoreService({ repo: storeRepo, db, clock: () => '2026-01-01T00:00:00.000Z', newId });
  storeId = stores.createStore({ projectId: 'p1', displayName: 'Ore' }).id;
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: ADMIN_TOKEN, sessions, approvals: new ApprovalService({ db, bus }), managers, pulseScheduler, bus,
    modelTable: { ...DEFAULT_MODEL_TABLE }, modelConfigPath: join(scratch, 'config.json'), stores, storeRepo, projects,
    mcp: async (_req, res) => streamingMcpHandler(res),
  });
});
afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});

interface Answer { status: number; headers: Record<string, string | string[] | undefined>; text: string }

function send(method: string, path: string, headers: Record<string, string>, body?: string): Promise<Answer> {
  const { port } = new URL(server.url);
  const lengthHeader: Record<string, string> = body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) };
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, agent: false, headers: { ...headers, ...lengthHeader } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('aborted', () => reject(new Error('the daemon aborted the response')));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Announces a body and never sends it: an answer that arrives proves the daemon did not wait for the body. */
function sendHeadersOnly(method: string, path: string, headers: Record<string, string>, announcedBytes: number): Promise<Answer> {
  const { port } = new URL(server.url);
  return new Promise((resolve, reject) => {
    const giveUp = setTimeout(() => { req.destroy(); reject(new Error('no answer while the body is still missing')); }, 2000);
    const req = request({ host: '127.0.0.1', port, path, method, agent: false, headers: { ...headers, 'content-length': String(announcedBytes) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => { clearTimeout(giveUp); req.destroy(); resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }); });
    });
    req.on('error', () => undefined);
    req.flushHeaders();
  });
}

describe('user without the admin token gets one closed answer', () => {
  it.each([
    ['no authorization header', {}],
    ['an empty bearer', { authorization: 'Bearer ' }],
    ['a token of the right length', { authorization: `Bearer ${'z'.repeat(ADMIN_TOKEN.length)}` }],
    ['a token of another length', { authorization: 'Bearer short' }],
    ['the real token with one character missing', { authorization: `Bearer ${ADMIN_TOKEN.slice(0, -1)}` }],
    ['the real token in another scheme', { authorization: `Basic ${ADMIN_TOKEN}` }],
  ])('answers %s with the very same body as a missing token, on a read and on a write', async (_case, credentials) => {
    const routes: [string, string][] = [['GET', '/api/sessions'], ['POST', '/api/sessions/ghost/close']];

    for (const [method, path] of routes) {
      const reference = await send(method, path, JSON_ONLY);
      const answer = await send(method, path, { ...JSON_ONLY, ...credentials });

      expect({ status: answer.status, text: answer.text, errorId: answer.headers['x-openfleet-error-id'] })
        .toEqual({ status: 401, text: reference.text, errorId: undefined });
    }
  });

  it.each([
    ['an admin route', '/api/sessions', 401, 'unauthorized'],
    ['the mcp route', '/mcp', 401, 'unauthorized'],
  ])('answers %s before the body it announced has arrived', async (_route, path, status, error) => {
    const answer = await sendHeadersOnly('POST', path, { ...JSON_ONLY, authorization: 'Bearer wrong' }, OVER_THE_BODY_CAP.length);

    expect({ status: answer.status, error: JSON.parse(answer.text).error }).toEqual({ status, error });
  });

  it('answers an unknown hook token before the body it announced has arrived', async () => {
    const answer = await sendHeadersOnly('POST', '/hooks/no-such-token', JSON_ONLY, OVER_THE_BODY_CAP.length);

    expect({ status: answer.status, text: answer.text }).toEqual({ status: 200, text: '{}' });
  });
});

describe('user cannot tell another project’s data store from a missing one', () => {
  it('answers a store of another project byte for byte like a store that never existed, without the id', async () => {
    const foreign = await send('GET', `/api/data-stores/${storeId}?projectId=p2`, ADMIN);
    const missing = await send('GET', `/api/data-stores/${'0'.repeat(storeId.length)}?projectId=p2`, ADMIN);

    expect({ status: foreign.status, text: foreign.text.replaceAll(storeId, '<id>') }).toEqual({ status: 404, text: missing.text.replaceAll('0'.repeat(storeId.length), '<id>') });
    expect(foreign.text).not.toContain(storeId);
    expect(missing.text).not.toContain('0'.repeat(storeId.length));
  });

  it('answers the changes of an unknown row without echoing the row id', async () => {
    const rowId = 'row-id-the-caller-typed';

    const answer = await send('GET', `/api/data-stores/${storeId}/rows/${rowId}/changes?projectId=p1`, ADMIN);

    expect(answer.status).toBe(404);
    expect(answer.text).not.toContain(rowId);
  });

  it('answers rows of an unknown store without echoing the store id', async () => {
    const unknownStoreId = 'store-id-the-caller-typed';

    const answer = await send('GET', `/api/data-stores/${unknownStoreId}/rows?projectId=p1`, ADMIN);

    expect(answer.status).toBe(404);
    expect(answer.text).not.toContain(unknownStoreId);
  });
});

describe('user of a busy daemon does not drown its log in refusals', () => {
  it('writes no log line for a flood of unknown routes and refused tokens', async () => {
    const answers: Answer[] = [];
    for (let index = 0; index < 40; index += 1) {
      answers.push(await send('GET', `/nowhere/${index}`, ADMIN));
      answers.push(await send('GET', '/api/sessions', JSON_ONLY));
      answers.push(await send('POST', '/mcp', JSON_ONLY, '{}'));
      answers.push(await send('POST', `/hooks/%E0%A4%Ag${index}`, JSON_ONLY, '{}'));
    }

    expect(new Set(answers.map(({ status }) => status))).toEqual(new Set([404, 401]));
    expect(logWrites()).toEqual([]);
  });
});

describe('user whose request fails after the daemon started answering', () => {
  it('sees the answer end instead of hanging, and the daemon keeps answering', async () => {
    const session = await sessions.create({ directory: scratch, name: 'Gimli', harness: 'fake', emoji: '⛏️' });
    const mcpBearer = { authorization: `Bearer ${sessions.tokens(session.id)!.mcpToken}`, 'content-type': 'application/json' };
    streamingMcpHandler = (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: partial\n\n');
      throw new Error('the stream broke /Users/someone/secret');
    };

    const streamed = await Promise.race([
      send('POST', '/mcp', mcpBearer, '{}'),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 3000)),
    ]);
    const nextAnswer = await send('GET', '/health', JSON_ONLY);

    expect(streamed).not.toBe('hung');
    expect(nextAnswer.status).toBe(200);
  });
});
