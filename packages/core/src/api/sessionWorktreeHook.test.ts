import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { makeRepo } from '../git/testRepo.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { newId } from '../ids.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { SessionService } from '../sessions/sessionService.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { startServer } from './server.js';

const ADMIN_TOKEN = 'admin';
const tempDirs = createTempDirTracker();

let server: Awaited<ReturnType<typeof startServer>>;
let sessions: SessionService;
let projects: ProjectRepository;
let worktreesRoot: string;
let projectId: string;
let repoPath: string;

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${server.url}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const createInWorktree = (branchName: string, extra: Record<string, unknown> = { projectId }) =>
  call('POST', '/api/sessions', { directory: '/tmp', name: `Task ${branchName}`, harness: 'fake', emoji: '🤖', repoPath, branchName, ...extra });
function aHookScript(body: string): string {
  const path = join(tempDirs.make('of-session-hook-'), 'hook.sh');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
  return path;
}
const configureHook = (script: string, timeoutSeconds?: number) => projects.update(projectId, { postCreateHookScript: script, ...(timeoutSeconds !== undefined && { postCreateHookTimeoutSeconds: timeoutSeconds }) });

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  worktreesRoot = realpathSync(tempDirs.make('of-session-hook-wt-'));
  sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot, submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  projects = new ProjectRepository(db);
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: ADMIN_TOKEN, sessions, approvals: new ApprovalService({ db, bus }), managers, pulseScheduler, bus,
    modelTable: { ...DEFAULT_MODEL_TABLE }, modelConfigPath: '/tmp/of-unused/config.json', projects,
  });
  projectId = newId();
  projects.insert({ id: projectId, name: 'Fleet', docsFolderPath: null, createdAt: 'now' });
  repoPath = realpathSync(makeRepo());
});
afterEach(async () => {
  await sessions.closeAll();
  await server.close();
  tempDirs.removeAll();
});

describe('POST /api/sessions with repoPath and branchName: the project post-create hook', () => {
  it('answers the plain session, with no warnings, when no hook is configured', async () => {
    const res = await createInWorktree('task/plain');

    expect(res.status).toBe(201);
    expect(await res.json()).not.toHaveProperty('warnings');
  });

  it('runs the hook in the new worktree before the session starts and adds no warning when it succeeds', async () => {
    const marker = join(tempDirs.make('of-session-out-'), 'cwd.txt');
    configureHook(aHookScript(`pwd -P > "${marker}"`));

    const res = await createInWorktree('task/ok');

    expect(res.status).toBe(201);
    const session = (await res.json()) as Session;
    expect(session).not.toHaveProperty('warnings');
    expect(readFileSync(marker, 'utf8').trim()).toBe(realpathSync(session.directory));
    expect(session).toMatchObject({ branch: 'task/ok' });
  });

  it('starts the session and answers a warning when the hook fails', async () => {
    configureHook(aHookScript('echo "setup broke" >&2\nexit 2'));

    const res = await createInWorktree('task/failing');

    expect(res.status).toBe(201);
    const created = (await res.json()) as Session & { warnings: { reason: string; exitCode: number; outputTail: string }[] };
    expect(created.warnings).toEqual([{ type: 'post_create_hook_failed', reason: 'exit_nonzero', exitCode: 2, outputTail: expect.stringContaining('setup broke') }]);
    expect(created.state).toBe('starting');
    expect(existsSync(join(created.directory, '.git'))).toBe(true);
    const stored = (await (await call('GET', `/api/sessions/${created.id}`)).json()) as Session;
    expect(stored).not.toHaveProperty('warnings');
  });

  it('starts the session and answers a timeout warning when the hook runs too long', async () => {
    configureHook(aHookScript('sleep 30'), 1);

    const res = await createInWorktree('task/slow');

    expect(res.status).toBe(201);
    expect(((await res.json()) as { warnings: { reason: string }[] }).warnings).toMatchObject([{ reason: 'timeout' }]);
  }, 20_000);

  it('does not run the hook of a project the session does not belong to', async () => {
    const marker = join(tempDirs.make('of-session-out-'), 'ran.txt');
    configureHook(aHookScript(`touch "${marker}"`));

    const res = await createInWorktree('task/unlinked', {});

    expect(res.status).toBe(201);
    expect(existsSync(marker)).toBe(false);
  });
});
