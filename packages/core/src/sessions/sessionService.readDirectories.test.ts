import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EventBus } from '../events/eventBus.js';
import { FakeHarness } from '../harness/fakeHarness.js';
import { parseStoredReadDirectories, stillReadableDirectories } from './readDirectories.js';
import { SessionService } from './sessionService.js';

const serviceOptions = { baseUrl: 'http://127.0.0.1:7331', worktreesRoot: '/tmp/of-wt' };
const temporaryRoots: string[] = [];

function makeRealRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'of-readdirs-')));
  temporaryRoots.push(root);
  return root;
}

function makeDirectoryIn(root: string, name: string): string {
  const directory = join(root, name);
  mkdirSync(directory);
  return directory;
}

async function createArbiterLikeSession({ readDirectories, db = openDatabase(':memory:'), bus = new EventBus() }: { readDirectories: string[]; db?: ReturnType<typeof openDatabase>; bus?: EventBus }) {
  const original = new SessionService({ db, bus, harnesses: [new FakeHarness()], ...serviceOptions });
  const session = await original.create({ directory: '/tmp', name: 'Arbiter', harness: 'fake', emoji: '⚖️', readDirectories });
  return { db, bus, session };
}

async function relaunchAfterDaemonRestart({ db, bus }: { db: ReturnType<typeof openDatabase>; bus: EventBus }) {
  const restartHarness = new FakeHarness();
  const restarted = new SessionService({ db, bus, harnesses: [restartHarness], ...serviceOptions, resumeTimeoutMs: 50 });
  await restarted.resumeAll();
  return { restarted, restartHarness };
}

describe('SessionService with read directories', () => {
  afterEach(() => {
    temporaryRoots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it('relaunches a resumed session with the read directories it was created with', async () => {
    const root = makeRealRoot();
    const worktree = makeDirectoryIn(root, 'worktree');
    const { db, bus } = await createArbiterLikeSession({ readDirectories: [worktree] });

    const { restartHarness } = await relaunchAfterDaemonRestart({ db, bus });

    expect(restartHarness.launches[0]!.resuming).toBe(true);
    expect(restartHarness.launches[0]!.readDirectories).toEqual([worktree]);
  });

  it('relaunches a reopened session with the read directories it was created with', async () => {
    const root = makeRealRoot();
    const worktree = makeDirectoryIn(root, 'worktree');
    const harness = new FakeHarness();
    const sessions = new SessionService({ db: openDatabase(':memory:'), bus: new EventBus(), harnesses: [harness], ...serviceOptions });
    const session = await sessions.create({ directory: '/tmp', name: 'Arbiter', harness: 'fake', emoji: '⚖️', readDirectories: [worktree] });
    await sessions.close(session.id);

    sessions.reopen(session.id);

    expect(harness.launches.at(-1)!.readDirectories).toEqual([worktree]);
  });

  it('drops a stored directory that is gone, is a file, or now resolves through a symlink, and keeps the others', async () => {
    const root = makeRealRoot();
    const kept = makeDirectoryIn(root, 'kept');
    const removed = makeDirectoryIn(root, 'removed');
    const aFile = join(root, 'a-file');
    writeFileSync(aFile, 'not a directory');
    const linkTarget = makeDirectoryIn(root, 'link-target');
    const replacedBySymlink = join(root, 'replaced');
    mkdirSync(replacedBySymlink);
    const { db, bus } = await createArbiterLikeSession({ readDirectories: [kept, removed, aFile, replacedBySymlink] });
    rmSync(removed, { recursive: true });
    rmSync(replacedBySymlink, { recursive: true });
    symlinkSync(linkTarget, replacedBySymlink);

    const { restartHarness } = await relaunchAfterDaemonRestart({ db, bus });

    expect(restartHarness.launches[0]!.readDirectories).toEqual([kept]);
  });

  it('resumes without any read directory when none of the stored ones is valid anymore', async () => {
    const root = makeRealRoot();
    const removed = makeDirectoryIn(root, 'removed');
    const { db, bus } = await createArbiterLikeSession({ readDirectories: [removed] });
    rmSync(removed, { recursive: true });

    const { restartHarness, restarted } = await relaunchAfterDaemonRestart({ db, bus });

    expect(restartHarness.launches[0]!.resuming).toBe(true);
    expect(restartHarness.launches[0]!.readDirectories ?? []).toEqual([]);
    expect(restarted.list().every((session) => session.state !== 'closed')).toBe(true);
  });

  it('resumes a session created without read directories exactly as before', async () => {
    const db = openDatabase(':memory:');
    const bus = new EventBus();
    const original = new SessionService({ db, bus, harnesses: [new FakeHarness()], ...serviceOptions });
    await original.create({ directory: '/tmp', name: 'Gimli', harness: 'fake', emoji: '⚔️' });

    const { restartHarness } = await relaunchAfterDaemonRestart({ db, bus });

    expect(restartHarness.launches[0]!.readDirectories).toBeUndefined();
  });

  it('reads malformed stored JSON as no directory without throwing', () => {
    const notAnArray = ['{"path":"/tmp"}', '"/tmp"', 'null', '42', 'not json at all', null];

    const readings = notAnArray.map((stored) => parseStoredReadDirectories(stored));

    expect(readings).toEqual(notAnArray.map(() => []));
  });

  it('drops non-string entries, relative paths and paths with a NUL byte without throwing', () => {
    const root = makeRealRoot();
    const valid = makeDirectoryIn(root, 'valid');
    const stored = JSON.stringify([valid, 42, null, { path: valid }, 'relative/dir', `${valid}\0evil`]);

    const readable = stillReadableDirectories(parseStoredReadDirectories(stored));

    expect(readable).toEqual([valid]);
  });

  it('keeps the read directories out of the session as the API shows it', async () => {
    const root = makeRealRoot();
    const worktree = makeDirectoryIn(root, 'worktree');
    const { db, bus, session } = await createArbiterLikeSession({ readDirectories: [worktree] });
    const { restarted } = await relaunchAfterDaemonRestart({ db, bus });

    const everythingTheApiShows = JSON.stringify([session, restarted.get(session.id), restarted.list()]);

    expect(everythingTheApiShows).not.toContain(worktree);
    expect(everythingTheApiShows).not.toContain('readDirectories');
    expect(everythingTheApiShows).not.toContain('read_directories');
  });
});
