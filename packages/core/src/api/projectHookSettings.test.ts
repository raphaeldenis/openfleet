import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ErrorEnvelope, Page, Project } from '@openfleet/shared';
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

const CLOCK = '2026-10-07T10:00:00.000Z';
const ADMIN_TOKEN = 'admin';
const tempDirs = createTempDirTracker();

let server: Awaited<ReturnType<typeof startServer>>;

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${server.url}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body) });
const createProject = async (): Promise<Project> => (await (await call('POST', '/api/projects', { name: 'Fleet' })).json()) as Project;
const patchProject = (id: string, body: unknown) => call('PATCH', `/api/projects/${id}`, body);
const listProjects = async () => ((await (await call('GET', '/api/projects')).json()) as Page<Project>).items;

function aScript(mode = 0o700): string {
  const path = join(tempDirs.make('of-hook-setting-'), 'setup.sh');
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, mode);
  return path;
}

beforeEach(async () => {
  const db = openDatabase(':memory:');
  const bus = new EventBus();
  const sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: tempDirs.make('of-hook-setting-wt-'), submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  const managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const projects = new ProjectRepository(db);
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => CLOCK, newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => CLOCK });
  const projectService = new ProjectService({ projects, docs, clock: () => CLOCK, newId });
  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: ADMIN_TOKEN, sessions, approvals: new ApprovalService({ db, bus }), managers, pulseScheduler, bus,
    modelTable: { ...DEFAULT_MODEL_TABLE }, modelConfigPath: '/tmp/of-unused/config.json', notes, noteRepo, docs, projects, projectService,
  });
});
afterEach(async () => {
  await server.close();
  tempDirs.removeAll();
});

describe('PATCH /api/projects/:id: the post-create hook setting', () => {
  it('stores the script and its timeout, and lists them with the project', async () => {
    const project = await createProject();
    const script = aScript();

    const res = await patchProject(project.id, { postCreateHookScript: script, postCreateHookTimeoutSeconds: 90 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...project, postCreateHookScript: script, postCreateHookTimeoutSeconds: 90 });
    expect(await listProjects()).toEqual([{ ...project, postCreateHookScript: script, postCreateHookTimeoutSeconds: 90 }]);
  });

  it('stores the script alone, without a timeout', async () => {
    const project = await createProject();
    const script = aScript();

    const res = await patchProject(project.id, { postCreateHookScript: script });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...project, postCreateHookScript: script });
  });

  it('clears the script and the timeout with null', async () => {
    const project = await createProject();
    await patchProject(project.id, { postCreateHookScript: aScript(), postCreateHookTimeoutSeconds: 90 });

    const res = await patchProject(project.id, { postCreateHookScript: null, postCreateHookTimeoutSeconds: null });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(project);
    expect(await listProjects()).toEqual([project]);
  });

  it('keeps the hook setting when only the name changes', async () => {
    const project = await createProject();
    const script = aScript();
    await patchProject(project.id, { postCreateHookScript: script, postCreateHookTimeoutSeconds: 30 });

    const res = await patchProject(project.id, { name: 'Renamed' });

    expect(await res.json()).toEqual({ ...project, name: 'Renamed', postCreateHookScript: script, postCreateHookTimeoutSeconds: 30 });
  });

  it('keeps the other fields when a script is added', async () => {
    const project = await createProject();
    await patchProject(project.id, { name: 'Renamed' });

    const res = await patchProject(project.id, { postCreateHookScript: aScript() });

    expect(await res.json()).toMatchObject({ id: project.id, name: 'Renamed' });
  });

  it.each([
    ['a relative path', () => 'scripts/setup.sh'],
    ['a script that does not exist', () => join(tempDirs.make('of-hook-setting-'), 'missing.sh')],
    ['a directory', () => tempDirs.make('of-hook-setting-')],
    ['a script without the execute bit', () => aScript(0o600)],
    ['a script writable by group', () => aScript(0o770)],
    ['a script writable by others', () => aScript(0o707)],
  ])('refuses %s with 400 invalid_body, leaves the setting alone and keeps the path out of the message', async (_name, makeScript) => {
    const project = await createProject();
    const script = makeScript();

    const res = await patchProject(project.id, { postCreateHookScript: script });

    expect(res.status).toBe(400);
    const envelope = (await res.json()) as ErrorEnvelope;
    expect(envelope).toMatchObject({ error: 'invalid_body', kind: 'invalid_request' });
    expect(JSON.stringify(envelope)).not.toContain(script);
    expect(await listProjects()).toEqual([project]);
  });

  it.each([0, -5, 601, 1.5, '60'])('refuses the timeout %j with 400 invalid_body', async (timeout) => {
    const project = await createProject();

    const res = await patchProject(project.id, { postCreateHookScript: aScript(), postCreateHookTimeoutSeconds: timeout });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_body' });
    expect(await listProjects()).toEqual([project]);
  });

  it('accepts the bounds of the timeout: 1 and 600 seconds', async () => {
    const project = await createProject();
    const script = aScript();

    expect((await patchProject(project.id, { postCreateHookScript: script, postCreateHookTimeoutSeconds: 1 })).status).toBe(200);
    expect((await patchProject(project.id, { postCreateHookTimeoutSeconds: 600 })).status).toBe(200);
  });

  it('refuses a timeout without any script configured', async () => {
    const project = await createProject();

    const res = await patchProject(project.id, { postCreateHookTimeoutSeconds: 30 });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_body' });
  });

  it('answers 404 project_not_found for an unknown project', async () => {
    const res = await patchProject('00000000-0000-4000-8000-000000000000', { postCreateHookScript: aScript() });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'project_not_found' });
  });

  it('still refuses an empty patch', async () => {
    const project = await createProject();

    expect((await patchProject(project.id, {})).status).toBe(400);
  });
});
