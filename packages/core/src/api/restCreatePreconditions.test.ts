import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { describeError } from '../errors/describeError.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

let scratch: string;
let server: Awaited<ReturnType<typeof startServer>> | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'of-create-preconditions-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
  server = undefined;
});

async function bootWithEnv(env: NodeJS.ProcessEnv) {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: join(scratch, 'worktrees'), env, describeError });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({ host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: join(scratch, 'config.json') });
  return server;
}

const createInWorktree = (repoPath: string) => fetch(`${server!.url}/api/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer admin' },
  body: JSON.stringify({ directory: scratch, name: 'G', harness: 'fake', repoPath, branchName: 'feature/x' }),
});

describe('POST /api/sessions with repoPath and branchName', () => {
  it('answers directory_missing 409 when the repository directory does not exist, without the path', async () => {
    await bootWithEnv({ PATH: process.env.PATH });
    const missingRepoPath = join(scratch, 'no-such-repo');

    const res = await createInWorktree(missingRepoPath);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toMatchObject({ error: 'directory_missing', kind: 'conflict', retry: 'never', message: 'the repository directory does not exist.' });
    expect(JSON.stringify(body)).not.toContain(scratch);
  });

  it('answers git_unavailable 503 when git is not on the daemon PATH', async () => {
    const emptyBin = join(scratch, 'empty-bin');
    mkdirSync(emptyBin);
    const repoWithoutGit = join(scratch, 'repo');
    mkdirSync(repoWithoutGit);
    await bootWithEnv({ PATH: emptyBin });

    const res = await createInWorktree(repoWithoutGit);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body).toMatchObject({
      error: 'git_unavailable', kind: 'unavailable', retry: 'never',
      message: 'git is not available to the daemon.', hint: 'Install git or start the daemon from a shell where git runs.',
    });
    expect(JSON.stringify(body)).not.toContain(scratch);
  });
});
