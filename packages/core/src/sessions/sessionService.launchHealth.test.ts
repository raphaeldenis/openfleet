import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenFleetError, type ServerEvent } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { BinaryHealthCheck } from '../harness/binaryHealth.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { recentLogLines } from '../logger.js';
import { SessionService } from './sessionService.js';

const LAUNCH_OUTPUT_TIMEOUT_MS = 30_000;
const START_SIGNAL_TIMEOUT_BEYOND_THESE_TESTS_MS = 600_000;
const FAKE_BINARY_PATH = '/fake/bin/claude';
const spec = { name: 'worker', emoji: '🤖', directory: '/tmp', harness: 'fake' } as const;

class HarnessWithBinary extends FakeHarness {
  constructor(private readonly path: string) { super(); }
  binaryPath(): string { return this.path; }
}

const healthyProbe = () => vi.fn().mockResolvedValue({ exitCode: 0, stdout: '2.1.0 (Claude Code)\n', stderr: '' });
const brokenProbe = () => vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'dyld: Library not loaded' });

function bootDaemon({ harness = new FakeHarness(), binaryHealth, launchOutputTimeoutMs }: { harness?: FakeHarness; binaryHealth?: BinaryHealthCheck; launchOutputTimeoutMs?: number } = {}) {
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const db = openDatabase(':memory:');
  const service = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', binaryHealth, launchOutputTimeoutMs, firstStartTimeoutMs: START_SIGNAL_TIMEOUT_BEYOND_THESE_TESTS_MS });
  return { service, harness, events };
}

describe('the harness binary check before a spawn', () => {
  it('refuses the spawn with harness_binary_broken, names the path and the stderr, and creates no session', async () => {
    const harness = new HarnessWithBinary(FAKE_BINARY_PATH);
    const { service } = bootDaemon({ harness, binaryHealth: new BinaryHealthCheck({ run: brokenProbe() }) });

    const failure = await service.create(spec).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OpenFleetError);
    expect((failure as OpenFleetError).code).toBe('harness_binary_broken');
    expect((failure as OpenFleetError).message).toContain(FAKE_BINARY_PATH);
    expect((failure as OpenFleetError).message).toContain('dyld: Library not loaded');
    expect(service.list()).toEqual([]);
    expect(harness.launches).toEqual([]);
  });

  it('refuses a real fake binary that exits 1 in well under 35 seconds', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'of-fake-claude-'));
    const path = join(directory, 'claude');
    writeFileSync(path, '#!/bin/sh\necho "segfault" 1>&2\nexit 1\n');
    chmodSync(path, 0o755);
    const { service } = bootDaemon({ harness: new HarnessWithBinary(path), binaryHealth: new BinaryHealthCheck() });
    const startedAt = Date.now();

    const failure = await service.create(spec).catch((error: unknown) => error);

    expect((failure as OpenFleetError).code).toBe('harness_binary_broken');
    expect(Date.now() - startedAt).toBeLessThan(35_000);
  });

  it('spawns normally with a healthy binary and logs its path and version', async () => {
    const harness = new HarnessWithBinary(FAKE_BINARY_PATH);
    const { service } = bootDaemon({ harness, binaryHealth: new BinaryHealthCheck({ run: healthyProbe() }) });
    const logLinesBefore = recentLogLines().length;

    const session = await service.create(spec);

    expect(session.state).toBe('starting');
    expect(harness.launches).toHaveLength(1);
    const spawnLog = recentLogLines().slice(logLinesBefore).join('\n');
    expect(spawnLog).toContain(FAKE_BINARY_PATH);
    expect(spawnLog).toContain('2.1.0 (Claude Code)');
  });

  it('probes the binary once for two spawns inside the cache window', async () => {
    const probe = healthyProbe();
    const { service } = bootDaemon({ harness: new HarnessWithBinary(FAKE_BINARY_PATH), binaryHealth: new BinaryHealthCheck({ run: probe }) });

    await service.create(spec);
    await service.create({ ...spec, name: 'second' });

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('leaves a harness that names no binary untouched', async () => {
    const { service, harness } = bootDaemon({ binaryHealth: new BinaryHealthCheck({ run: brokenProbe() }) });

    await service.create(spec);

    expect(harness.launches).toHaveLength(1);
  });
});

describe('a launch that produces no output', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const bootFamily = async () => {
    const daemon = bootDaemon({ launchOutputTimeoutMs: LAUNCH_OUTPUT_TIMEOUT_MS });
    const parent = await daemon.service.create({ ...spec, name: 'manager' });
    const child = await daemon.service.create({ ...spec, name: 'child', parentId: parent.id });
    const notifications = vi.spyOn(daemon.service, 'sendMessage');
    return { ...daemon, parent, child, notifications };
  };

  it('announces readiness failed with no_output_at_launch at the deadline', async () => {
    const { child, events } = await bootFamily();

    await vi.advanceTimersByTimeAsync(LAUNCH_OUTPUT_TIMEOUT_MS);

    expect(events).toContainEqual({ type: 'session.updated', session: expect.objectContaining({ id: child.id, readiness: 'failed', readinessReason: 'no_output_at_launch' }) });
  });

  it('keeps the session pending before the deadline', async () => {
    const { service, child } = await bootFamily();

    await vi.advanceTimersByTimeAsync(LAUNCH_OUTPUT_TIMEOUT_MS - 1);

    expect(service.get(child.id)?.readiness).toBe('pending');
  });

  it('notifies the parent manager of the failure', async () => {
    const { parent, child, notifications } = await bootFamily();

    await vi.advanceTimersByTimeAsync(LAUNCH_OUTPUT_TIMEOUT_MS);

    expect(notifications).toHaveBeenCalledWith(expect.objectContaining({ sessionId: parent.id, body: expect.stringContaining(child.id) }));
    expect(notifications.mock.calls[0]![0].body).toContain('no_output_at_launch');
  });

  it('relaunches the session once on its own and kills the stalled process', async () => {
    const { service, harness, child } = await bootFamily();

    await vi.advanceTimersByTimeAsync(LAUNCH_OUTPUT_TIMEOUT_MS);

    const childLaunches = harness.launches.filter((launch) => launch.sessionId === child.id);
    expect(childLaunches).toHaveLength(2);
    const stalledChildHandle = harness.handles[1];
    expect(stalledChildHandle?.killed).toBe(true);
    expect(service.get(child.id)?.readiness).toBe('pending');
  });

  it('fails for good after the retry also stalls, with no third launch', async () => {
    const { service, harness, child, notifications } = await bootFamily();

    await vi.advanceTimersByTimeAsync(LAUNCH_OUTPUT_TIMEOUT_MS * 2);

    expect(harness.launches.filter((launch) => launch.sessionId === child.id)).toHaveLength(2);
    expect(service.get(child.id)).toMatchObject({ readiness: 'failed', readinessReason: 'no_output_at_launch' });
    expect(notifications).toHaveBeenCalledTimes(2);
  });

  it('relaunches although a live session of the same name exists: the retry is the session itself', async () => {
    const { harness, child } = await bootFamily();

    await vi.advanceTimersByTimeAsync(LAUNCH_OUTPUT_TIMEOUT_MS);

    expect(harness.launches.filter((launch) => launch.sessionId === child.id)).toHaveLength(2);
  });

  it('is ready, not failed, once a PTY byte arrived', async () => {
    const { service, harness, child, notifications } = await bootFamily();
    harness.handles.at(-1)!.emitData('Welcome to Claude Code');

    await vi.advanceTimersByTimeAsync(LAUNCH_OUTPUT_TIMEOUT_MS * 2);

    expect(service.get(child.id)?.readiness).toBe('ready');
    expect(notifications).not.toHaveBeenCalled();
    expect(harness.launches.filter((launch) => launch.sessionId === child.id)).toHaveLength(1);
  });

  it('is ready, not failed, once the transcript progressed without a PTY byte', async () => {
    const { service, harness, child } = await bootFamily();
    harness.handles.at(-1)!.transcriptCursor = { identity: 'transcript-1', offset: 120 };

    await vi.advanceTimersByTimeAsync(LAUNCH_OUTPUT_TIMEOUT_MS);

    expect(service.get(child.id)?.readiness).toBe('ready');
  });

  it('leaves a running session that produced output untouched', async () => {
    const { service, harness, parent } = await bootFamily();
    const parentHandle = harness.handles[0]!;
    parentHandle.emitData('Welcome to Claude Code');

    await vi.advanceTimersByTimeAsync(LAUNCH_OUTPUT_TIMEOUT_MS * 1.5);

    expect(parentHandle.killed).toBe(false);
    expect(service.get(parent.id)?.readiness).toBe('ready');
  });

  it('is not watched when no launch output timeout is configured', async () => {
    const { service, child } = await (async () => {
      const daemon = bootDaemon();
      return { ...daemon, child: await daemon.service.create(spec) };
    })();

    await vi.advanceTimersByTimeAsync(LAUNCH_OUTPUT_TIMEOUT_MS * 2);

    expect(service.get(child.id)?.readiness).toBeUndefined();
  });
});
