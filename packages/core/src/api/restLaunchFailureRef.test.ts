import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { describeError } from '../errors/describeError.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { recentLogLines } from '../logger.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

const SPAWN_FAILURE_MESSAGE = 'synthetic spawn failure';

let scratch: string;
let server: Awaited<ReturnType<typeof startServer>> | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'of-launch-failure-ref-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
  server = undefined;
});

async function bootDaemon() {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const harness = new FakeHarness();
  const sessions = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: join(scratch, 'worktrees'), describeError });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: join(scratch, 'config.json') });
  return { harness, sessions, events };
}

const failLaunch = (harness: FakeHarness) => vi.spyOn(harness, 'start').mockImplementation(() => { throw new Error(SPAWN_FAILURE_MESSAGE); });
const postAsAdmin = (path: string, body?: unknown) => fetch(`${server!.url}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer admin' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const errorLogRecordsSince = (logLineCount: number) => recentLogLines().slice(logLineCount).map((line) => JSON.parse(line) as { id: string }).filter((record) => (record as { level?: string }).level === 'error');
const watchedErrorRefs = (events: ServerEvent[]) => events.flatMap((event) => (event.type === 'error' ? [event.error.id] : []));

describe.each([
  { route: 'create', expectedStatus: 500, launchFailingRequest: () => postAsAdmin('/api/sessions', { directory: scratch, name: 'G', harness: 'fake' }) },
  { route: 'reopen', expectedStatus: 500, launchFailingRequest: undefined },
])('a REST $route whose launch fails', ({ route, expectedStatus, launchFailingRequest }) => {
  it('leaves one error record, whose ref is both the REST envelope id and the watchers ref, carrying the original cause', async () => {
    const { harness, sessions, events } = await bootDaemon();
    const reopenedSessionId = route === 'reopen' ? (await sessions.create({ name: 'G', emoji: '🤖', directory: scratch, harness: 'fake' })).id : undefined;
    if (reopenedSessionId) await sessions.close(reopenedSessionId);
    failLaunch(harness);
    events.length = 0;
    const logLinesBefore = recentLogLines().length;

    const res = await (launchFailingRequest ? launchFailingRequest() : postAsAdmin(`/api/sessions/${reopenedSessionId}/reopen`));
    const body = await res.json();

    expect(res.status).toBe(expectedStatus);
    const records = errorLogRecordsSince(logLinesBefore);
    expect(records).toHaveLength(1);
    expect(watchedErrorRefs(events)).toEqual([records[0]!.id]);
    expect(body.id).toBe(records[0]!.id);
    expect(JSON.stringify(records[0])).toContain(SPAWN_FAILURE_MESSAGE);
  });
});
