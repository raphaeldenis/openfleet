import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { NoteSummary, Session } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { ApprovalService } from '../governance/approvalService.js';
import { FakeHarness, type FakeHandle } from '../harness/fakeHarness.js';
import { newId } from '../ids.js';
import { ManagerRepository } from '../managers/managerRepository.js';
import { ManagerService } from '../managers/managerService.js';
import { PulseScheduler } from '../managers/pulseScheduler.js';
import { DEFAULT_MODEL_TABLE } from '../models.js';
import { DocsFolderService } from '../notes/docsFolderService.js';
import type { GitCallOptions, GitPort } from '../notes/gitPort.js';
import { registerHandoffOnClose } from '../notes/handoffService.js';
import { expandMentions } from '../notes/mentionExpander.js';
import { nodeDocsFolderFs } from '../notes/nodeDocsFolderFs.js';
import { NoteRepository } from '../notes/noteRepository.js';
import { NoteService } from '../notes/noteService.js';
import { ProjectRepository } from '../projects/projectRepository.js';
import { SessionService } from '../sessions/sessionService.js';
import { TodoTracker } from '../todos/todoTracker.js';
import { WorkingStateService } from '../workingState/workingStateService.js';
import { createHandoffRouteDeps } from './handoffRoutes.js';
import { startServer } from './server.js';

const ADMIN = { authorization: 'Bearer admin', 'content-type': 'application/json' };
const CLOCK = '2026-10-04T10:00:00.000Z';
const CRASH_EXIT_CODE = 1;
const GIT_CALL_DURATION_MS = 1_500;
const CLOSE_HANDOFF_GIT_BUDGET_MS = 4_000;
const SECRET_CANARY = 'sk-ant-api03-CANARYHF07AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const isRoot = process.getuid?.() === 0;

type GitCall = { operation: 'status' | 'diff'; timeoutMs: number | undefined };

let server: Awaited<ReturnType<typeof startServer>>;
let db: DatabaseSync;
let bus: EventBus;
let sessions: SessionService;
let managers: ManagerService;
let projects: ProjectRepository;
let docs: DocsFolderService;
let docsFolder: string;
let writeOnCloseSetting: boolean;
let unsubscribeHandoffOnClose: () => unknown;
let temporaryPaths: string[];
let projectReadsFail: boolean;
let writerBreaks: boolean;
let events: string[];
let gitCalls: GitCall[];
let gitClockMs: number;

const makeTemporaryDirectory = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
};
const post = (path: string, body?: unknown) =>
  fetch(`${server.url}${path}`, { method: 'POST', headers: ADMIN, body: body === undefined ? undefined : JSON.stringify(body) });
const closeSession = (sessionId: string, body?: unknown) => post(`/api/sessions/${sessionId}/close`, body);
const handoffFiles = () => (existsSync(join(docsFolder, 'handoffs')) ? readdirSync(join(docsFolder, 'handoffs')) : []);
const attachProject = (sessionId: string, projectId: string) => db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(projectId, sessionId);
const makeProject = (name = 'p-docs') => {
  projects.insert({ id: 'p-docs', name, docsFolderPath: docsFolder, createdAt: 't0' });
  docs.ensureLayout(docsFolder);
};
const sessionWithDocsFolder = async (name = 'Gimli'): Promise<Session> => {
  if (!projects.get('p-docs')) makeProject();
  const session = await sessions.create({ directory: '/tmp', name, harness: 'fake', emoji: '⛏️' });
  attachProject(session.id, 'p-docs');
  return session;
};
const crash = (sessionId: string) => (sessions.harnessHandle(sessionId) as FakeHandle).emitExit(CRASH_EXIT_CODE);

function recordGitCall(operation: GitCall['operation'], options?: GitCallOptions): string {
  events.push('git');
  gitCalls.push({ operation, timeoutMs: options?.timeoutMs });
  gitClockMs += GIT_CALL_DURATION_MS;
  return ' M src/app.ts';
}

async function boot(): Promise<void> {
  db = openDatabase(':memory:');
  bus = new EventBus();
  bus.subscribe((event) => { if (event.type === 'session.closed') events.push('closed'); });
  sessions = new SessionService({ db, bus, harnesses: [new FakeHarness()], baseUrl: 'http://127.0.0.1:0', worktreesRoot: '/tmp/of-wt', submitKeystrokeDelayMs: 0 });
  const managerRepo = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepo, sessions, bus });
  managers = new ManagerService({ managers: managerRepo, sessions, bus, scheduler: pulseScheduler });
  const approvals = new ApprovalService({ db, bus });
  const workingStates = new WorkingStateService({ db, clock: () => CLOCK, stateRoot: makeTemporaryDirectory('of-ws-'), maxBytes: 6144 });
  const todos = new TodoTracker({ sessions, bus });
  projects = new ProjectRepository(db);
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => CLOCK, newId });
  docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => CLOCK });
  const git: GitPort = {
    statusShort: (_directory, options) => recordGitCall('status', options),
    diffStatOf: (_directory, options) => recordGitCall('diff', options),
  };
  const projectsRead = { get: (id: string) => { if (projectReadsFail) throw new Error('database is locked'); return projects.get(id); } };
  const settings = { writeOnClose: writeOnCloseSetting };
  const handoff = createHandoffRouteDeps({ sessions, managers, workingStates, todos, docs, projects: projectsRead, git, settings, clock: () => CLOCK, nowMs: () => gitClockMs });
  unsubscribeHandoffOnClose = registerHandoffOnClose(bus, handoff.handoffs, { writeOnClose: settings.writeOnClose });
  const writeHandoffOnClose: typeof handoff.writeHandoffOnClose = (sessionId) => {
    if (writerBreaks) throw new Error('writer broke');
    return handoff.writeHandoffOnClose(sessionId);
  };

  server = await startServer({
    host: '127.0.0.1', port: 0, adminToken: 'admin', sessions, approvals, managers, pulseScheduler, bus, modelTable: { ...DEFAULT_MODEL_TABLE }, modelConfigPath: '/tmp/of-unused/config.json',
    handoff: { ...handoff, writeHandoffOnClose },
  });
}

async function shutDown(): Promise<void> {
  unsubscribeHandoffOnClose();
  await server.close();
  db.close();
  temporaryPaths.forEach((path) => rmSync(path, { recursive: true, force: true }));
}

beforeEach(async () => {
  temporaryPaths = [];
  writeOnCloseSetting = true;
  projectReadsFail = false;
  writerBreaks = false;
  events = [];
  gitCalls = [];
  gitClockMs = 0;
  docsFolder = makeTemporaryDirectory('of-close-handoff-docs-');
  await boot();
});
afterEach(shutDown);

describe('POST /api/sessions/:id/close with writeHandoff', () => {
  it('writes the handoff, closes the session and answers the written path', async () => {
    const session = await sessionWithDocsFolder();

    const res = await closeSession(session.id, { writeHandoff: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handoff: { status: 'written', relativePath: 'handoffs/2026-10-04-gimli.md' } });
    expect(handoffFiles()).toEqual(['2026-10-04-gimli.md']);
    expect(sessions.get(session.id)?.state).toBe('closed');
  });

  it.each([
    ['no body', undefined],
    ['an empty object', {}],
    ['writeHandoff false', { writeHandoff: false }],
  ])('writes nothing and answers no handoff with %s', async (_label, body) => {
    const session = await sessionWithDocsFolder();

    const res = await closeSession(session.id, body);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(handoffFiles()).toEqual([]);
    expect(sessions.get(session.id)?.state).toBe('closed');
  });

  it('refuses an unknown key in the body with invalid_body and keeps the session open', async () => {
    const session = await sessionWithDocsFolder();

    const res = await closeSession(session.id, { writeHandoff: true, path: '../x' });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_body' });
    expect(sessions.get(session.id)?.state).not.toBe('closed');
  });

  it('closes and skips the handoff when the session has no docs folder', async () => {
    const session = await sessions.create({ directory: '/tmp', name: 'Loose', harness: 'fake', emoji: '⛏️' });

    const res = await closeSession(session.id, { writeHandoff: true });

    expect(await res.json()).toEqual({ handoff: { status: 'skipped', reason: 'target_unavailable' } });
    expect(sessions.get(session.id)?.state).toBe('closed');
  });

  it('skips the handoff when one was saved by hand a moment ago', async () => {
    const session = await sessionWithDocsFolder();
    const sections = { goal: 'g', state: 's', decisions: 'd', filesTouched: 'f', nextSteps: 'n', openQuestions: 'q' };
    await post(`/api/sessions/${session.id}/handoff`, sections);

    const res = await closeSession(session.id, { writeHandoff: true });

    expect(await res.json()).toEqual({ handoff: { status: 'skipped', reason: 'recent_manual_handoff' } });
    expect(handoffFiles()).toHaveLength(1);
  });

  it.skipIf(isRoot)('still closes the session when the handoff cannot be written, and says why', async () => {
    const session = await sessionWithDocsFolder();
    chmodSync(join(docsFolder, 'handoffs'), 0o500);

    const res = await closeSession(session.id, { writeHandoff: true });
    chmodSync(join(docsFolder, 'handoffs'), 0o700);

    const { handoff } = (await res.json()) as { handoff: { status: string; error: string; message: string } };
    expect(res.status).toBe(200);
    expect(handoff).toMatchObject({ status: 'failed', error: 'docs_folder_not_writable' });
    expect(handoff.message).toContain('not writable');
    expect(sessions.get(session.id)?.state).toBe('closed');
  });

  it('still closes the session when reading the session and project data throws', async () => {
    const session = await sessionWithDocsFolder();
    projectReadsFail = true;

    const res = await closeSession(session.id, { writeHandoff: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ handoff: { status: 'failed' } });
    expect(sessions.get(session.id)?.state).toBe('closed');
  });

  it('closes the session at the route even when the handoff writer itself breaks', async () => {
    const session = await sessionWithDocsFolder();
    writerBreaks = true;

    await closeSession(session.id, { writeHandoff: true });

    expect(sessions.get(session.id)?.state).toBe('closed');
  });

  it('answers 404 for an unknown session', async () => {
    const res = await closeSession('nope', { writeHandoff: true });

    expect(res.status).toBe(404);
  });
});

describe('closing a session twice', () => {
  it('writes no handoff for a session that is already closed', async () => {
    const session = await sessionWithDocsFolder();
    await closeSession(session.id, { writeHandoff: false });

    const res = await closeSession(session.id, { writeHandoff: true });

    expect(await res.json()).toEqual({ handoff: { status: 'skipped', reason: 'already_closed' } });
    expect(handoffFiles()).toEqual([]);
  });

  it('writes the handoff once when the same close is repeated', async () => {
    const session = await sessionWithDocsFolder();
    await closeSession(session.id, { writeHandoff: true });

    const second = await closeSession(session.id, { writeHandoff: true });

    expect(await second.json()).toEqual({ handoff: { status: 'skipped', reason: 'already_closed' } });
    expect(handoffFiles()).toHaveLength(1);
  });

  it('writes the handoff once when two closes arrive together', async () => {
    const session = await sessionWithDocsFolder();

    const answers = await Promise.all([closeSession(session.id, { writeHandoff: true }), closeSession(session.id, { writeHandoff: true })]);
    const handoffs = await Promise.all(answers.map(async (answer) => ((await answer.json()) as { handoff: { status: string; reason?: string } }).handoff));

    expect(handoffs).toContainEqual({ status: 'written', relativePath: 'handoffs/2026-10-04-gimli.md' });
    expect(handoffs.filter((handoff) => handoff.status === 'skipped')).toHaveLength(1);
    expect(handoffFiles()).toHaveLength(1);
  });

  it('answers already_written to a second close that arrives while the first is still stopping the process', async () => {
    const session = await sessionWithDocsFolder();
    const handle = sessions.harnessHandle(session.id) as FakeHandle;
    const stopProcess = handle.kill.bind(handle);
    let letProcessStop = () => {};
    handle.kill = () => { letProcessStop = () => stopProcess(); };
    const closeCalls = vi.spyOn(sessions, 'close');
    const firstClose = closeSession(session.id, { writeHandoff: true });
    await vi.waitFor(() => expect(handoffFiles()).toHaveLength(1));

    const secondClose = closeSession(session.id, { writeHandoff: true });
    await vi.waitFor(() => expect(closeCalls).toHaveBeenCalledTimes(2));
    letProcessStop();
    await firstClose;

    expect(await (await secondClose).json()).toEqual({ handoff: { status: 'skipped', reason: 'already_written' } });
    expect(handoffFiles()).toHaveLength(1);
  });

  it('still lets a handoff be saved by hand from a closed session', async () => {
    const session = await sessionWithDocsFolder();
    await closeSession(session.id);
    const sections = { goal: 'g', state: 's', decisions: 'd', filesTouched: 'f', nextSteps: 'n', openQuestions: 'q' };

    const res = await post(`/api/sessions/${session.id}/handoff`, sections);

    expect(res.status).toBe(201);
  });
});

describe('what the handoff of a closing session reveals', () => {
  it('masks a secret in the session name and the project name in the file, the note and the path', async () => {
    makeProject(`Atlas ${SECRET_CANARY}`);
    const session = await sessionWithDocsFolder(`Gimli ${SECRET_CANARY}`);

    const res = await closeSession(session.id, { writeHandoff: true });

    const { handoff } = (await res.json()) as { handoff: { status: string; relativePath: string } };
    const [file] = handoffFiles();
    const content = readFileSync(join(docsFolder, 'handoffs', file!), 'utf8');
    const notes = (await (await fetch(`${server.url}/api/notes?projectId=p-docs&folder=handoffs`, { headers: ADMIN })).json()) as { items: NoteSummary[] };
    expect(handoff.status).toBe('written');
    expect(content).not.toContain('CANARYHF07');
    expect(file).not.toContain('canaryhf07');
    expect(handoff.relativePath.toLowerCase()).not.toContain('canaryhf07');
    expect(JSON.stringify(notes)).not.toContain('CANARYHF07');
  });
});

describe('the time a close can spend collecting the handoff', () => {
  it('collects the handoff before the session closes', async () => {
    const session = await sessionWithDocsFolder();

    await closeSession(session.id, { writeHandoff: true });

    expect(events).toEqual(['git', 'git', 'closed']);
  });

  it('gives the git calls of one handoff a single budget, whatever their number', async () => {
    const manager = await managers.createManagerSession({ directory: '/tmp', name: 'Boss', emoji: '🧭', harness: 'fake', manager: { mission: 'Ship', childrenCap: 5 } });
    makeProject();
    attachProject(manager.id, 'p-docs');
    await Promise.all([1, 2, 3].map((index) => sessions.create({ directory: '/tmp', name: `kid-${index}`, harness: 'fake', emoji: '⛏️', parentId: manager.id })));

    await closeSession(manager.id, { writeHandoff: true });

    const timeouts = gitCalls.map((call) => call.timeoutMs);
    expect(timeouts).toEqual([4_000, 2_500, 1_000]);
    expect(Math.max(...timeouts.map((timeout) => timeout ?? Infinity))).toBeLessThanOrEqual(CLOSE_HANDOFF_GIT_BUDGET_MS);
    expect(sessions.get(manager.id)?.state).toBe('closed');
  });
});

describe('the automatic handoff on close', () => {
  it('writes one handoff when the agent process crashes', async () => {
    const session = await sessionWithDocsFolder();

    crash(session.id);

    expect(handoffFiles()).toEqual(['2026-10-04-gimli.md']);
  });

  it('writes nothing when the user closes without asking for a handoff', async () => {
    const session = await sessionWithDocsFolder();

    await closeSession(session.id);

    expect(handoffFiles()).toEqual([]);
  });

  it('writes nothing when the user closes with the box unchecked', async () => {
    const session = await sessionWithDocsFolder();

    await closeSession(session.id, { writeHandoff: false });

    expect(handoffFiles()).toEqual([]);
  });

  it('writes nothing on a daemon shutdown', async () => {
    await sessionWithDocsFolder();

    await sessions.closeAll();

    expect(handoffFiles()).toEqual([]);
  });

  it('writes a single handoff when the user asks for one, and the close event adds none', async () => {
    const session = await sessionWithDocsFolder();

    await closeSession(session.id, { writeHandoff: true });

    expect(handoffFiles()).toHaveLength(1);
  });

  it('writes nothing on a crash when the setting is off', async () => {
    await shutDown();
    temporaryPaths = [];
    writeOnCloseSetting = false;
    docsFolder = makeTemporaryDirectory('of-close-handoff-docs-');
    await boot();
    const session = await sessionWithDocsFolder();

    crash(session.id);

    expect(handoffFiles()).toEqual([]);
  });
});
