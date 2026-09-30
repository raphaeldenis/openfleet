import { OpenFleetError, type ServerEvent } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { describeError } from '../errors/describeError.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { recentLogLines } from '../logger.js';
import { RESUME_LAUNCH_FAILED_EXIT_CODE, SessionReopenError, SessionService } from './sessionService.js';

const spec = { name: 'worker', emoji: '🤖', directory: '/tmp', harness: 'fake' } as const;
const SPAWN_FAILURE_MESSAGE = 'synthetic spawn failure';

type Database = ReturnType<typeof openDatabase>;

function bootDaemon(db: Database = openDatabase(':memory:')) {
  const harness = new FakeHarness();
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const service = new SessionService({ db, bus, harnesses: [harness], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', describeError });
  return { db, harness, service, events };
}

const failLaunchWith = (harness: FakeHarness, error: Error) => {
  vi.spyOn(harness, 'start').mockImplementation(() => { throw error; });
};

const closuresOf = (events: ServerEvent[]) => events.filter((event) => event.type === 'session.closed');
const errorsOf = (events: ServerEvent[]) => events.filter((event) => event.type === 'error');
const errorLogRecordsSince = (logLineCount: number) => recentLogLines().slice(logLineCount).map((line) => JSON.parse(line) as Record<string, unknown>).filter((record) => record.level === 'error');
const claudeNotFound = () => new OpenFleetError('claude_not_found', 'the claude CLI is not on the daemon PATH.');

async function closedSession() {
  const daemon = bootDaemon();
  const session = await daemon.service.create(spec);
  await daemon.service.close(session.id);
  daemon.events.length = 0;
  return { ...daemon, sessionId: session.id, closedAtBeforeReopen: daemon.service.get(session.id)!.closedAt };
}

describe('a generic launch failure on create', () => {
  it('leaves one error record, the one whose ref the client receives, and it carries the original cause', async () => {
    const { harness, service, events } = bootDaemon();
    failLaunchWith(harness, new Error(SPAWN_FAILURE_MESSAGE));
    const logLinesBefore = recentLogLines().length;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(service.create(spec)).rejects.toThrow(SPAWN_FAILURE_MESSAGE);

    const advertisedRef = (errorsOf(events)[0] as { error: { id: string } }).error.id;
    const records = errorLogRecordsSince(logLinesBefore);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: advertisedRef });
    expect(JSON.stringify(records[0])).toContain(SPAWN_FAILURE_MESSAGE);
  });
});

describe('a named launch failure on create', () => {
  it('leaves one error record with the original cause', async () => {
    const { harness, service, events } = bootDaemon();
    failLaunchWith(harness, claudeNotFound());
    const logLinesBefore = recentLogLines().length;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(service.create(spec)).rejects.toThrow('the claude CLI is not on the daemon PATH.');

    expect(errorsOf(events)).toMatchObject([{ error: { error: 'claude_not_found' } }]);
    const records = errorLogRecordsSince(logLinesBefore);
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records[0])).toContain('the claude CLI is not on the daemon PATH.');
  });
});

describe.each([
  { kind: 'generic', failure: () => new Error(SPAWN_FAILURE_MESSAGE), thrown: SessionReopenError, errorCode: 'launch_failed' },
  { kind: 'named unavailable', failure: claudeNotFound, thrown: OpenFleetError, errorCode: 'claude_not_found' },
])('a $kind launch failure on reopening an ordinary closed row', ({ failure, thrown, errorCode }) => {
  it('finalizes the row like a failed resume: exit -2, a fresh closed_at, one session.closed and one error event, the error reaching the caller', async () => {
    const { harness, service, events, sessionId, closedAtBeforeReopen } = await closedSession();
    failLaunchWith(harness, failure());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(() => service.reopen(sessionId)).toThrow(thrown);

    expect(closuresOf(events)).toEqual([{ type: 'session.closed', sessionId, exitCode: RESUME_LAUNCH_FAILED_EXIT_CODE, reason: 'launch_failed' }]);
    expect(errorsOf(events)).toMatchObject([{ sessionId, error: { error: errorCode } }]);
    const row = service.get(sessionId)!;
    expect(row.state).toBe('closed');
    expect(row.exitCode).toBe(RESUME_LAUNCH_FAILED_EXIT_CODE);
    expect(row.closedAt! > closedAtBeforeReopen!).toBe(true);
  });

  it('shows a reconnecting client the exit code the live clients were told, and the next boot does not resume the row', async () => {
    const { db, harness, service, events, sessionId } = await closedSession();
    failLaunchWith(harness, failure());
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => service.reopen(sessionId)).toThrow(thrown);

    const liveExitCode = (closuresOf(events)[0] as { exitCode: number }).exitCode;
    expect(service.get(sessionId)!.exitCode).toBe(liveExitCode);
    const nextBoot = bootDaemon(db);
    await nextBoot.service.resumeAll();
    expect(nextBoot.harness.launches).toEqual([]);
  });
});

describe('reopening an ordinary closed row whose harness is missing', () => {
  it('finalizes the row the same way', async () => {
    const { db, service, events, sessionId, closedAtBeforeReopen } = await closedSession();
    db.prepare("UPDATE sessions SET harness = 'gone' WHERE id = ?").run(sessionId);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(() => service.reopen(sessionId)).toThrow(SessionReopenError);

    expect(closuresOf(events)).toEqual([{ type: 'session.closed', sessionId, exitCode: RESUME_LAUNCH_FAILED_EXIT_CODE, reason: 'launch_failed' }]);
    expect(errorsOf(events)).toMatchObject([{ sessionId, error: { error: 'launch_failed' } }]);
    const row = service.get(sessionId)!;
    expect(row.exitCode).toBe(RESUME_LAUNCH_FAILED_EXIT_CODE);
    expect(row.closedAt! > closedAtBeforeReopen!).toBe(true);
  });
});
