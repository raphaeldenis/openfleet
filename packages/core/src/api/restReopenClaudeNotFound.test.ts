import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { describeError } from '../errors/describeError.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

const spawn = vi.fn();
vi.mock('node-pty', () => ({ spawn }));
vi.mock('../harness/claudeCli/trustDirectory.js', () => ({ markDirectoryTrusted: vi.fn() }));

const { ClaudeCliHarness } = await import('../harness/claudeCli/claudeCliHarness.js');

let scratch: string;
let emptyBin: string;
let binWithClaude: string;
let server: Awaited<ReturnType<typeof startServer>> | undefined;

beforeEach(() => {
  spawn.mockReset();
  scratch = mkdtempSync(join(tmpdir(), 'of-reopen-claude-not-found-'));
  emptyBin = join(scratch, 'empty-bin');
  mkdirSync(emptyBin);
  binWithClaude = join(scratch, 'bin-with-claude');
  mkdirSync(binWithClaude);
  writeFileSync(join(binWithClaude, 'claude'), '#!/bin/sh\n');
  chmodSync(join(binWithClaude, 'claude'), 0o755);
  spawn.mockImplementation(() => {
    const exitListeners: Array<(exit: { exitCode: number }) => void> = [];
    const exit = () => exitListeners.splice(0).forEach((listener) => listener({ exitCode: 0 }));
    return {
      onData: () => ({ dispose: () => undefined }),
      onExit: (listener: (exit: { exitCode: number }) => void) => { exitListeners.push(listener); return { dispose: () => undefined }; },
      write: () => exit(), resize: vi.fn(), kill: () => exit(),
    };
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
  server = undefined;
});

function bootDaemon(db: ReturnType<typeof openDatabase>, env: NodeJS.ProcessEnv) {
  const bus = new EventBus();
  const events: Array<Record<string, unknown>> = [];
  bus.subscribe((event) => events.push(event as unknown as Record<string, unknown>));
  const sessions = new SessionService({
    db, bus, harnesses: [new ClaudeCliHarness(join(scratch, 'sessions'), env)],
    baseUrl: 'http://127.0.0.1:0', worktreesRoot: join(scratch, 'worktrees'), describeError,
  });
  return { sessions, bus, events };
}

async function serve(daemon: ReturnType<typeof bootDaemon>) {
  const { sessions, bus } = daemon;
  const approvals = new ApprovalService({ db: openDatabase(':memory:'), bus });
  const managerRepo = new ManagerRepository(openDatabase(':memory:'));
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: join(scratch, 'config.json') });
}

const createSession = (daemon: ReturnType<typeof bootDaemon>) => daemon.sessions.create({ name: 'a', emoji: '🤖', directory: scratch, harness: 'claude-cli' });
const reopenOverRest = (sessionId: string) => fetch(`${server!.url}/api/sessions/${sessionId}/reopen`, { method: 'POST', headers: { authorization: 'Bearer admin' } });
const failureEventsAfter = (events: Array<Record<string, unknown>>, from: number) => events.slice(from).filter((event) => ['session.closed', 'error', 'session.reopened'].includes(String(event.type)));

const CLOCK_TICK_MS = 5;
const CLAUDE_NOT_FOUND_ENVELOPE = {
  error: 'claude_not_found', kind: 'unavailable', retry: 'never',
  message: 'the claude CLI is not on the daemon PATH.', hint: 'Install Claude Code or start the daemon from a shell where claude runs.',
};

describe('reopening a closed claude-cli session when claude is not on the daemon PATH', () => {
  it('answers the claude_not_found 503 envelope and announces the failure once, finalizing the closed row as a failed launch', async () => {
    const env = { PATH: binWithClaude };
    const db = openDatabase(':memory:');
    const daemon = bootDaemon(db, env);
    const session = await createSession(daemon);
    await daemon.sessions.close(session.id);
    const closedRow = daemon.sessions.get(session.id)!;
    await serve(daemon);
    env.PATH = emptyBin;
    const eventCountBeforeReopen = daemon.events.length;
    await new Promise((resolve) => setTimeout(resolve, CLOCK_TICK_MS));

    const res = await reopenOverRest(session.id);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body).toMatchObject(CLAUDE_NOT_FOUND_ENVELOPE);
    expect(body).not.toHaveProperty('id');
    expect(JSON.stringify(body)).not.toContain(emptyBin);
    expect(failureEventsAfter(daemon.events, eventCountBeforeReopen)).toEqual([
      { type: 'session.closed', sessionId: session.id, reason: 'launch_failed' },
      { type: 'error', sessionId: session.id, scope: 'broadcast', error: expect.objectContaining(CLAUDE_NOT_FOUND_ENVELOPE) },
    ]);
    const failedRow = daemon.sessions.get(session.id)!;
    expect(failedRow).toMatchObject({ state: 'closed' });
    expect(failedRow.exitCode).toBeUndefined();
    expect(failedRow.closedAt! > closedRow.closedAt!).toBe(true);
  });

  it('answers the same envelope for a session the daemon shutdown closed, finalizes it -2 and drops the shutdown marker', async () => {
    const env = { PATH: binWithClaude };
    const db = openDatabase(':memory:');
    const firstDaemon = bootDaemon(db, env);
    const session = await createSession(firstDaemon);
    await firstDaemon.sessions.closeAll();
    const secondDaemon = bootDaemon(db, env);
    await serve(secondDaemon);
    env.PATH = emptyBin;
    const eventCountBeforeReopen = secondDaemon.events.length;

    const res = await reopenOverRest(session.id);
    const body = await res.json();
    const spawnsAfterReopen = spawn.mock.calls.length;
    await bootDaemon(db, { PATH: binWithClaude }).sessions.resumeAll();

    expect(res.status).toBe(503);
    expect(body).toMatchObject(CLAUDE_NOT_FOUND_ENVELOPE);
    expect(failureEventsAfter(secondDaemon.events, eventCountBeforeReopen)).toEqual([
      { type: 'session.closed', sessionId: session.id, reason: 'launch_failed' },
      { type: 'error', sessionId: session.id, scope: 'broadcast', error: expect.objectContaining(CLAUDE_NOT_FOUND_ENVELOPE) },
    ]);
    const secondSession = secondDaemon.sessions.get(session.id)!;
    expect(secondSession).toMatchObject({ state: 'closed' });
    expect(secondSession.exitCode).toBeUndefined();
    expect(spawn.mock.calls.length).toBe(spawnsAfterReopen);
  });

  it('keeps the ordinary 500 launch_failed answer when the launch fails for another reason', async () => {
    const env = { PATH: binWithClaude };
    const db = openDatabase(':memory:');
    const daemon = bootDaemon(db, env);
    const session = await createSession(daemon);
    await daemon.sessions.close(session.id);
    await serve(daemon);
    spawn.mockImplementation(() => { throw new Error('spawn exploded'); });

    const res = await reopenOverRest(session.id);

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'launch_failed', kind: 'internal' });
  });
});

describe('booting the daemon when claude is not on the PATH', () => {
  it('finalizes each shutdown-closed row -2 and announces claude_not_found once per row', async () => {
    const env = { PATH: binWithClaude };
    const db = openDatabase(':memory:');
    const firstDaemon = bootDaemon(db, env);
    const first = await createSession(firstDaemon);
    const second = await createSession(firstDaemon);
    await firstDaemon.sessions.closeAll();
    const bootingDaemon = bootDaemon(db, { PATH: emptyBin });

    await bootingDaemon.sessions.resumeAll();

    for (const { id } of [first, second]) {
      const session = bootingDaemon.sessions.get(id)!;
      expect(session).toMatchObject({ state: 'closed' });
      expect(session.exitCode).toBeUndefined();
      expect(bootingDaemon.events.filter((event) => event.type === 'error' && event.sessionId === id)).toEqual([
        { type: 'error', sessionId: id, scope: 'broadcast', error: expect.objectContaining(CLAUDE_NOT_FOUND_ENVELOPE) },
      ]);
      expect(bootingDaemon.events.filter((event) => event.type === 'session.closed' && event.sessionId === id)).toHaveLength(1);
    }
  });
});
