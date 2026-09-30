import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { createDegradedRegistry, type DegradedRegistry } from '../process/degradedRegistry.js';
import { SessionService } from '../sessions/sessionService.js';
import type { ContextNotice } from '../workingState/contextNotice.js';
import type { HandoverLedger } from '../workingState/handoverLedger.js';
import type { SessionStartContext } from '../workingState/sessionStartContext.js';
import type { StopRefusal } from '../workingState/stopRefusal.js';
import { startServer } from './server.js';

const MINUTE_MS = 60_000;
const throwing = (message: string) => () => { throw new Error(message); };

let server: Awaited<ReturnType<typeof startServer>>;
let db: DatabaseSync;
let hookToken: string;
let degraded: DegradedRegistry;
let nowMs: number;

async function startWith(failingParts: { stopRefusal?: StopRefusal; sessionStartContext?: SessionStartContext; handoverLedger?: HandoverLedger; contextNotice?: ContextNotice }) {
  nowMs = Date.parse('2026-09-30T10:00:00.000Z');
  degraded = createDegradedRegistry({ clock: () => nowMs });
  db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', degraded, ...failingParts });
  const session = await sessions.create({ directory: '/tmp', name: 'G', harness: 'fake', emoji: '🤖' });
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

const hook = (body: Record<string, unknown>) =>
  fetch(`${server.url}/hooks/${hookToken}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'c', ...body }) });
const stop = () => hook({ hook_event_name: 'Stop' });

describe('hooks that fail open count toward the degraded state', () => {
  it('answers {} and stays healthy for one or two failing hooks', async () => {
    await startWith({ stopRefusal: { decide: throwing('stop refusal bug') } as unknown as StopRefusal });

    const answers = [await stop(), await stop()];

    expect(await Promise.all(answers.map((answer) => answer.json()))).toEqual([{}, {}]);
    expect(degraded.status()).toBe('ok');
  });

  it('marks hook_fail_open on the third failing hook in five minutes, and the hook still answers {}', async () => {
    await startWith({ stopRefusal: { decide: throwing('stop refusal bug') } as unknown as StopRefusal });

    const answers = [await stop(), await stop(), await stop()];

    expect(await answers[2]!.json()).toEqual({});
    expect(degraded.list()).toMatchObject([{ code: 'hook_fail_open' }]);
  });

  it('counts the four fail-open branches together: a Stop, a SessionStart, a UserPromptSubmit and a context notice', async () => {
    await startWith({
      stopRefusal: { decide: throwing('a') } as unknown as StopRefusal,
      sessionStartContext: { build: throwing('b') } as unknown as SessionStartContext,
      handoverLedger: { record: throwing('c') } as unknown as HandoverLedger,
      contextNotice: { measureAtStop: throwing('d'), measureAtPrompt: throwing('d'), clearForNewConversation: throwing('d') } as unknown as ContextNotice,
    });

    await hook({ hook_event_name: 'Stop' });
    await hook({ hook_event_name: 'SessionStart', source: 'startup' });
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' });

    expect(degraded.status()).toBe('degraded');
  });

  it('clears after five clean minutes', async () => {
    await startWith({ stopRefusal: { decide: throwing('stop refusal bug') } as unknown as StopRefusal });
    await stop(); await stop(); await stop();
    expect(degraded.status()).toBe('degraded');

    nowMs += 5 * MINUTE_MS;

    expect(degraded.status()).toBe('ok');
  });

  it('does not count a hook that answers normally', async () => {
    await startWith({});

    for (let call = 0; call < 5; call += 1) await stop();

    expect(degraded.status()).toBe('ok');
  });
});
