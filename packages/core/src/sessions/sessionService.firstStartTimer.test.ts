import { MANAGER_ROLE } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { describeError } from '../errors/describeError.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { DEFAULT_LAUNCH_OUTPUT_TIMEOUT_MS, SessionService } from './sessionService.js';

const FIRST_START_TIMEOUT_MS = 60_000;
const ESCALATION_GRACE_MS = 30_000;
const THIRTY_SECONDS_PAST_THE_FIRST_START_TIMEOUT_MS = FIRST_START_TIMEOUT_MS + ESCALATION_GRACE_MS + 10_000;
const plainSpec = { name: 'worker', emoji: '🤖', directory: '/tmp', harness: 'fake' } as const;
const managerSpec = { ...plainSpec, name: 'captain', role: MANAGER_ROLE } as const;

function bootDaemon() {
  const service = new SessionService({
    db: openDatabase(':memory:'), bus: new EventBus(), harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', describeError,
    firstStartTimeoutMs: FIRST_START_TIMEOUT_MS, launchOutputTimeoutMs: DEFAULT_LAUNCH_OUTPUT_TIMEOUT_MS,
  });
  return service;
}

const reportSessionStart = (service: SessionService, sessionId: string) =>
  service.applyInput(sessionId, { kind: 'hook', event: { hook_event_name: 'SessionStart', session_id: sessionId, source: 'startup' } });

describe('the first-start timer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([{ label: 'plain', spec: plainSpec }, { label: 'manager', spec: managerSpec }])(
    'never closes a $label session that reported its SessionStart and sits idle',
    async ({ spec }) => {
      const service = bootDaemon();
      const session = await service.create(spec);
      vi.advanceTimersByTime(2_000);
      reportSessionStart(service, session.id);

      await vi.advanceTimersByTimeAsync(THIRTY_SECONDS_PAST_THE_FIRST_START_TIMEOUT_MS);

      expect(service.get(session.id)).toMatchObject({ state: 'idle' });
    },
  );

  it('does not relaunch a silent session that already reported its SessionStart', async () => {
    const harness = new FakeHarness();
    const service = new SessionService({
      db: openDatabase(':memory:'), bus: new EventBus(), harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', describeError,
      firstStartTimeoutMs: FIRST_START_TIMEOUT_MS, launchOutputTimeoutMs: DEFAULT_LAUNCH_OUTPUT_TIMEOUT_MS,
    });
    const session = await service.create(plainSpec);
    reportSessionStart(service, session.id);

    await vi.advanceTimersByTimeAsync(THIRTY_SECONDS_PAST_THE_FIRST_START_TIMEOUT_MS);

    expect(harness.handles).toHaveLength(1);
  });

  it('replaces the previous start timer when it rearms on a starting session', async () => {
    const harness = new FakeHarness();
    const service = new SessionService({
      db: openDatabase(':memory:'), bus: new EventBus(), harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', describeError,
      firstStartTimeoutMs: FIRST_START_TIMEOUT_MS, launchOutputTimeoutMs: DEFAULT_LAUNCH_OUTPUT_TIMEOUT_MS,
    });
    const session = await service.create(plainSpec);
    const timerCountBeforeRearm = vi.getTimerCount();
    const sessionWithPrivateRearm = service as unknown as { armFirstStartTimeout(sessionId: string, handle: unknown): void };

    sessionWithPrivateRearm.armFirstStartTimeout(session.id, harness.handles[0]);

    expect(vi.getTimerCount()).toBe(timerCountBeforeRearm);
  });

  it('still closes a session that never reports a SessionStart', async () => {
    const service = bootDaemon();
    const session = await service.create(plainSpec);

    await vi.advanceTimersByTimeAsync(THIRTY_SECONDS_PAST_THE_FIRST_START_TIMEOUT_MS);

    expect(service.get(session.id)).toMatchObject({ state: 'closed' });
  });
});
