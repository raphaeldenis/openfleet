import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { recentLogLines } from '../logger.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { createDegradedRegistry } from '../process/degradedRegistry.js';
import { SessionService } from '../sessions/sessionService.js';
import type { PerSessionTrailingThrottleOptions } from '../usage/perSessionTrailingThrottle.js';
import type { TranscriptUsageIngestion } from '../usage/transcriptUsageIngestion.js';
import { startServer } from './server.js';

let server: Awaited<ReturnType<typeof startServer>>;
let hookToken: string;
let sessionId: string;
let degraded: ReturnType<typeof createDegradedRegistry>;

const NO_WINDOW = { windowMs: 0 };
let bus: EventBus;

const listenerCountOf = (eventBus: EventBus): number => (eventBus as unknown as { listeners: Set<unknown> }).listeners.size;

async function startWith(usageIngestion?: Pick<TranscriptUsageIngestion, 'ingestAtStop'>, { usageIngestionThrottle = NO_WINDOW }: { usageIngestionThrottle?: Partial<PerSessionTrailingThrottleOptions> } = {}) {
  const db = openDatabase(':memory:');
  bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt' });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  degraded = createDegradedRegistry();
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: '/tmp/of-unused/config.json', degraded, usageIngestion, usageIngestionThrottle });
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

  it('logs the session and a code with the fixed message when the ingestion throws', async () => {
    const ingestAtStop = vi.fn(() => { throw new Error('ledger bug'); });
    await startWith({ ingestAtStop });

    await hook('Stop');

    await expect.poll(() => recentLogLines().filter((line) => line.includes('usage ingestion failed, recording nothing') && line.includes(sessionId) && line.includes('usage_ingestion_failed'))).toHaveLength(1);
  });

  it('counts a session that keeps failing once toward the degraded state, not once per Stop', async () => {
    const ingestAtStop = vi.fn(() => { throw new Error('unreadable transcript'); });
    await startWith({ ingestAtStop });

    for (let stop = 1; stop <= 5; stop += 1) {
      await hook('Stop');
      await expect.poll(() => ingestAtStop.mock.calls.length).toBe(stop);
    }

    expect(degraded.list()).toEqual([]);
  });

  describe('throughput bound of one session', () => {
    const WINDOW_MS = 300;

    function startWithManualTime() {
      const ingestAtStop = vi.fn();
      let nowMs = 0;
      const scheduled: (() => void)[] = [];
      const timers = new Map<number, { dueAtMs: number; task: () => void }>();
      let nextTimerId = 0;
      const throttle = {
        windowMs: WINDOW_MS,
        clock: () => nowMs,
        schedule: (task: () => void) => { scheduled.push(task); },
        startTimer: (task: () => void, delayMs: number) => {
          const timerId = nextTimerId++;
          timers.set(timerId, { dueAtMs: nowMs + delayMs, task });
          return () => timers.delete(timerId);
        },
      };
      const started = startWith({ ingestAtStop }, { usageIngestionThrottle: throttle });
      const runScheduled = () => scheduled.splice(0).forEach((task) => task());
      const advanceTo = (targetMs: number) => {
        nowMs = targetMs;
        for (const [timerId, { dueAtMs, task }] of [...timers]) {
          if (dueAtMs > nowMs) continue;
          timers.delete(timerId);
          task();
        }
      };
      return { ingestAtStop, started, runScheduled, advanceTo };
    }

    it('runs one ingestion at once and one trailing ingestion at the end of the window for a burst of Stops', async () => {
      const { ingestAtStop, started, runScheduled, advanceTo } = startWithManualTime();
      await started;

      for (let stop = 1; stop <= 5; stop += 1) await hook('Stop');
      runScheduled();
      const callsInsideTheWindow = ingestAtStop.mock.calls.length;
      advanceTo(WINDOW_MS);
      advanceTo(10 * WINDOW_MS);

      expect([callsInsideTheWindow, ingestAtStop.mock.calls.length]).toEqual([1, 2]);
    });

    it('drops the trailing ingestion of a session that closes inside the window', async () => {
      const { ingestAtStop, started, runScheduled, advanceTo } = startWithManualTime();
      await started;
      await hook('Stop');
      runScheduled();
      await hook('Stop');

      bus.emit({ type: 'session.closed', sessionId });
      advanceTo(WINDOW_MS);

      expect(ingestAtStop.mock.calls.length).toBe(1);
    });

    it('ingests the trailing Stop when the server begins to shut down, while the transcripts are still reachable', async () => {
      const { ingestAtStop, started, runScheduled } = startWithManualTime();
      await started;
      await hook('Stop');
      runScheduled();
      await hook('Stop');

      server.beginShutdown();

      expect(ingestAtStop.mock.calls.length).toBe(2);
    });

    it('ingests nothing for a Stop that arrives after the shutdown began', async () => {
      const { ingestAtStop, started, runScheduled, advanceTo } = startWithManualTime();
      await started;
      server.beginShutdown();

      await hook('Stop');
      runScheduled();
      advanceTo(WINDOW_MS);

      expect(ingestAtStop).not.toHaveBeenCalled();
    });

    it('stops listening to the closing of sessions when the server begins to shut down', async () => {
      const { started } = startWithManualTime();
      await started;
      const listenerCountBefore = listenerCountOf(bus);

      server.beginShutdown();

      expect(listenerCountOf(bus)).toBe(listenerCountBefore - 1);
    });
  });

  it('does nothing when the daemon was not given an ingestion', async () => {
    await startWith(undefined);

    expect((await hook('Stop')).status).toBe(200);
  });
});
