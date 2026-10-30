import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { createDegradedRegistry } from '../process/degradedRegistry.js';
import { SessionService } from '../sessions/sessionService.js';
import type { TranscriptUsageIngestion } from '../usage/transcriptUsageIngestion.js';
import { startServer } from './server.js';

let server: Awaited<ReturnType<typeof startServer>>;
let hookToken: string;
let sessionId: string;

async function startWith(usageIngestion?: Pick<TranscriptUsageIngestion, 'ingestAtStop'>) {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', degraded: createDegradedRegistry(), usageIngestion });
  const session = await sessions.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
  sessionId = session.id;
  hookToken = (db.prepare('SELECT hook_token FROM sessions WHERE id = ?').get(session.id) as { hook_token: string }).hook_token;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
});

const hook = (eventName: string) =>
  fetch(`${server.url}/hooks/${hookToken}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', hook_event_name: eventName }) });

describe('usage ingestion on the Stop hook', () => {
  it('ingests the transcript of the session when its turn stops', async () => {
    const ingestAtStop = vi.fn();
    await startWith({ ingestAtStop });

    expect((await hook('Stop')).status).toBe(200);

    await expect.poll(() => ingestAtStop.mock.calls).toEqual([[sessionId]]);
  });

  it('ingests nothing on a hook that is not a Stop', async () => {
    const ingestAtStop = vi.fn();
    await startWith({ ingestAtStop });

    await hook('UserPromptSubmit');
    await hook('Stop');

    await expect.poll(() => ingestAtStop.mock.calls.length).toBe(1);
  });

  it('answers the hook as usual when the ingestion throws', async () => {
    const ingestAtStop = vi.fn(() => { throw new Error('ledger bug'); });
    await startWith({ ingestAtStop });

    const response = await hook('Stop');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    await expect.poll(() => ingestAtStop.mock.calls.length).toBe(1);
  });

  it('does nothing when the daemon was not given an ingestion', async () => {
    await startWith(undefined);

    expect((await hook('Stop')).status).toBe(200);
  });
});
