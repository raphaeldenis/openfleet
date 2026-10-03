import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectBestCpuUnderAsync } from '../__testing__/linearGrowth.js';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { SessionService } from '../sessions/sessionService.js';
import { startServer } from './server.js';

const ADMIN_TOKEN = 'admin';

let server: Awaited<ReturnType<typeof startServer>>;
let scratchDirectory: string;
// An existing directory git refuses, whatever repository encloses os.tmpdir(): its broken .git gitfile stops git's search for a parent repository (the git child env drops GIT_CEILING_DIRECTORIES). A missing directory answers directory_missing (restCreatePreconditions.test.ts).
let notARepository: string;
let worktreesRoot: string;

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  scratchDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'of-worktree-errors-')));
  worktreesRoot = join(scratchDirectory, 'worktrees');
  mkdirSync(worktreesRoot);
  notARepository = join(scratchDirectory, 'not-a-repository');
  mkdirSync(notARepository);
  writeFileSync(join(notARepository, '.git'), 'gitdir: ./no-such-git-directory\n');
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot });
  const approvals = new ApprovalService({ db, bus });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: ADMIN_TOKEN, sessions, approvals, managers, pulseScheduler, bus,
    modelTable: DEFAULT_MODEL_TABLE, modelConfigPath: join(scratchDirectory, 'config.json'), e2eRoutes: false,
  });
});
afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
  rmSync(scratchDirectory, { recursive: true, force: true });
});

async function createSessionInWorktree(branchName: string) {
  const response = await fetch(`${server.url}/api/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ directory: scratchDirectory, name: 'worktree session', harness: 'fake', repoPath: notARepository, branchName }),
  });
  return { status: response.status, text: await response.text() };
}

describe('POST /api/sessions with repoPath and branchName: worktree failures', () => {
  it('answers 400 invalid_branch_name for a branch name git would refuse', async () => {
    const { status, text } = await createSessionInWorktree('a b');

    expect({ status, body: JSON.parse(text) }).toEqual({
      status: 400,
      body: { error: 'invalid_branch_name', kind: 'invalid_request', retry: 'never', message: 'invalid branch name: a b' },
    });
  });

  it('lets a branch name of 250 characters through to worktree creation', async () => {
    const { status, text } = await createSessionInWorktree('a'.repeat(250));

    expect({ status, error: JSON.parse(text).error }).toEqual({ status: 500, error: 'internal_error' });
  });

  it('answers 400 invalid_branch_name for a well-formed branch name of 251 characters, which git cannot lock', async () => {
    const { status, text } = await createSessionInWorktree('a'.repeat(251));

    expect({ status, error: JSON.parse(text).error }).toEqual({ status: 400, error: 'invalid_branch_name' });
  });

  it.each([
    ['a trailing dot', 'x.'],
    ['a .lock ending', 'x.lock'],
    ['a .lock ending on a path component', 'x.lock/y'],
    ['a component starting with a dot', 'x/.hidden'],
    ['a leading dot', '.hidden'],
    ['a trailing slash', 'x/'],
    ['an empty component', 'x//y'],
    ['a leading slash', '/x'],
    ['consecutive dots', 'x..y'],
    ['a space', 'x y'],
    ['a tilde', 'x~1'],
    ['a caret', 'x^'],
    ['a colon', 'x:y'],
    ['a question mark', 'x?'],
    ['an asterisk', 'x*'],
    ['an opening bracket', 'x[y'],
    ['a backslash', 'x\\y'],
    ['an at-brace sequence', 'x@{y'],
    ['a control character', 'x\u0007y'],
  ])('answers 400 invalid_branch_name for %s', async (_label, branchName) => {
    const { status, text } = await createSessionInWorktree(branchName);

    expect({ status, error: JSON.parse(text).error }).toEqual({ status: 400, error: 'invalid_branch_name' });
  });

  it.each(['feature/x-1', 'v1.2.3', '_private', 'a.b/c.d'])('lets the well-formed branch name %s through to worktree creation', async (branchName) => {
    const { status, text } = await createSessionInWorktree(branchName);

    expect({ status, error: JSON.parse(text).error }).toEqual({ status: 500, error: 'internal_error' });
  });

  it('answers 400 invalid_branch_name within a second for a branch name of 900 000 question marks', async () => {
    const hostileBranchName = '?'.repeat(900_000);

    await expectBestCpuUnderAsync(() => createSessionInWorktree(hostileBranchName), 1000);
    const { status, text } = await createSessionInWorktree(hostileBranchName);

    expect({ status, error: JSON.parse(text).error }).toEqual({ status: 400, error: 'invalid_branch_name' });
  });

  it('answers 409 worktree_exists, with no path, when the destination already exists', async () => {
    mkdirSync(join(worktreesRoot, 'taken'));

    const { status, text } = await createSessionInWorktree('taken');

    expect({ status, body: JSON.parse(text) }).toEqual({
      status: 409,
      body: { error: 'worktree_exists', kind: 'conflict', retry: 'never', message: 'the worktree already exists.' },
    });
    expect(text).not.toContain(scratchDirectory);
  });

  it('keeps a failed git command a 500 internal_error that carries no path and no git output', async () => {
    const { status, text } = await createSessionInWorktree('fresh-branch');

    expect({ status, error: JSON.parse(text).error }).toEqual({ status: 500, error: 'internal_error' });
    expect(text).not.toContain(notARepository);
    expect(text).not.toContain(scratchDirectory);
  });
});
