import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DetectedRepository, ErrorEnvelope } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { newId } from '../ids.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { DocsFolderService } from '../notes/docsFolderService.js';
import { expandMentions } from '../notes/mentionExpander.js';
import { nodeDocsFolderFs } from '../notes/nodeDocsFolderFs.js';
import { NoteRepository } from '../notes/noteRepository.js';
import { NoteService } from '../notes/noteService.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { ProjectService } from '../projects/projectService.js';
import { SessionService } from '../sessions/sessionService.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { startServer } from './server.js';

const CLOCK = '2026-10-29T10:00:00.000Z';
const ADMIN_TOKEN = 'admin';
const tempDirs = createTempDirTracker();

let server: Awaited<ReturnType<typeof startServer>>;

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${server.url}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const detect = (body: unknown) => call('POST', '/api/projects/detect', body);

/** A repository inside the docs folder of a registered project, so the route may read it. */
async function aRegisteredRepository(files: Record<string, string>): Promise<string> {
  const docsFolder = tempDirs.make('of-detect-route-');
  await call('POST', '/api/projects', { name: 'Fleet', docsFolderPath: docsFolder });
  const repository = join(docsFolder, 'repo');
  mkdirSync(repository);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(repository, name), content);
  return repository;
}

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: tempDirs.make('of-detect-route-wt-'), submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const projects = new ProjectRepository(db);
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => CLOCK, newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => CLOCK });
  const projectService = new ProjectService({ projects, docs, noteRepo, clock: () => CLOCK, newId });
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: ADMIN_TOKEN, sessions, approvals: new ApprovalService({ db, bus }), managers, pulseScheduler, bus,
    modelTable: { ...DEFAULT_MODEL_TABLE }, modelConfigPath: '/tmp/of-unused/config.json', notes, noteRepo, docs, projects, projectService,
  });
});
afterEach(async () => {
  await server.close();
  tempDirs.removeAll();
});

describe('POST /api/projects/detect', () => {
  it('answers the commands a registered project folder repository declares, without creating anything', async () => {
    const repository = await aRegisteredRepository({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run; rm -rf /' } }), 'pnpm-lock.yaml': '' });

    const response = await detect({ repositoryPath: repository });

    expect(response.status).toBe(200);
    const detected = (await response.json()) as DetectedRepository;
    expect(detected.commands.test).toEqual({ command: 'pnpm test', source: 'package.json' });
    expect(JSON.stringify(detected)).not.toContain('rm -rf');
  });

  it.each([
    ['a relative path', { repositoryPath: 'relative/repo' }, 400, 'invalid_body'],
    ['a .. segment', { repositoryPath: '/tmp/../etc' }, 400, 'invalid_body'],
    ['a missing field', {}, 400, 'invalid_body'],
    ['an unknown field', { repositoryPath: '/tmp', extra: 1 }, 400, 'invalid_body'],
    ['a non-string path', { repositoryPath: 42 }, 400, 'invalid_body'],
    ['a path of 5000 characters', { repositoryPath: `/${'a'.repeat(5000)}` }, 400, 'invalid_body'],
  ])('refuses %s', async (_label, body, status, code) => {
    const response = await detect(body);

    expect(response.status).toBe(status);
    expect(((await response.json()) as ErrorEnvelope).error).toBe(code);
  });

  it('refuses a directory that does not exist', async () => {
    const repository = await aRegisteredRepository({});

    const response = await detect({ repositoryPath: join(repository, 'missing') });

    expect(response.status).toBe(409);
    expect(((await response.json()) as ErrorEnvelope).error).toBe('directory_missing');
  });

  it('refuses a directory outside home and every registered project folder', async () => {
    const outside = tempDirs.make('of-detect-route-outside-');

    const response = await detect({ repositoryPath: outside });

    expect(response.status).toBe(409);
    expect(((await response.json()) as ErrorEnvelope).error).toBe('directory_unreadable');
  });

  it('refuses a request without the admin token', async () => {
    const response = await fetch(`${server.url}/api/projects/detect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repositoryPath: '/tmp' }) });

    expect(response.status).toBe(401);
  });

  it('answers 400 on malformed JSON', async () => {
    const response = await fetch(`${server.url}/api/projects/detect`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` }, body: '{oops' });

    expect(response.status).toBe(400);
  });
});
