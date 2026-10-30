import { chmodSync, linkSync, mkdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirTracker } from '../tempDirTracker.js';
import { ArtifactDirectory, managerDirectoryNameOf, type ArtifactJournal, type ArtifactJournalEntry } from './artifactDirectory.js';

const tempDirs = createTempDirTracker();
afterEach(() => tempDirs.removeAll());

const PROJECT_ID = 'project-1';
const MANAGER_ACTOR = { sessionId: 'manager-session', role: 'manager' as const };
const CHILD_ACTOR = { sessionId: 'child-session', role: 'child' as const, agentId: 'agent-7' };

function setup(settings = { maxFileBytes: 1024, maxProjectBytes: 4096 }, projectHasDocsFolder = true) {
  const docsFolder = tempDirs.make('of-artifacts-docs-');
  const entries: ArtifactJournalEntry[] = [];
  const journal: ArtifactJournal = { record: (entry) => { entries.push(entry); } };
  const directory = new ArtifactDirectory({ docsFolderPathOf: (projectId) => (projectId === PROJECT_ID && projectHasDocsFolder ? docsFolder : undefined), settings, journal });
  const artifactsDirectoryOf = (managerName: string) => directory.ensureFor({ projectId: PROJECT_ID, managerName })!;
  const write = (args: { filePath: unknown; content: unknown; managerName?: string; actor?: typeof MANAGER_ACTOR | typeof CHILD_ACTOR }) =>
    directory.judgeWrite({ projectId: PROJECT_ID, managerName: args.managerName ?? 'Mnemosyne', actor: args.actor ?? MANAGER_ACTOR, filePath: args.filePath, content: args.content });
  return { docsFolder, entries, directory, artifactsDirectoryOf, write };
}

describe('the artifact directory of a manager', () => {
  it('is created by the daemon under <docs folder>/artifacts/<manager>', () => {
    const { docsFolder, artifactsDirectoryOf } = setup();

    const directory = artifactsDirectoryOf('Mnemosyne');

    expect(directory).toBe(join(realpathSync.native(docsFolder), 'artifacts', 'Mnemosyne'));
    expect(statSync(directory).isDirectory()).toBe(true);
  });

  it('does not exist for a project without a docs folder', () => {
    const { directory } = setup(undefined, false);

    expect(directory.ensureFor({ projectId: PROJECT_ID, managerName: 'Mnemosyne' })).toBeUndefined();
  });

  it('is refused when the artifacts folder is a symlink leaving the docs folder', () => {
    const { docsFolder, directory } = setup();
    const outside = tempDirs.make('of-artifacts-outside-');
    symlinkSync(outside, join(docsFolder, 'artifacts'));

    expect(directory.ensureFor({ projectId: PROJECT_ID, managerName: 'Mnemosyne' })).toBeUndefined();
  });
});

describe('the directory name derived from a manager name', () => {
  it.each([
    ['../x', 'x'],
    ['/etc', 'etc'],
    ['..', 'manager'],
    ['', 'manager'],
    ['a\0b', 'a-b'],
    ['Mnémosyne 🤖', 'Mn-mosyne'],
    ['a/b\\c', 'a-b-c'],
  ])('turns %j into %j', (name, expected) => {
    expect(managerDirectoryNameOf(name)).toBe(expected);
  });

  it('caps a very long name', () => {
    expect(managerDirectoryNameOf('x'.repeat(5000)).length).toBeLessThanOrEqual(64);
  });

  it('never yields a separator, a NUL or a leading dot, whatever the name', () => {
    const hostile = ['../../x', '/etc/passwd', '\0', '.hidden', '....//..', '‮/..', '%2e%2e/', 'a\u0000/../b'];

    for (const name of hostile) {
      const derived = managerDirectoryNameOf(name);
      expect(derived).not.toMatch(/[\\/\0]/);
      expect(derived.startsWith('.')).toBe(false);
      expect(derived.length).toBeGreaterThan(0);
    }
  });

  it('keeps a hostile manager name inside the artifacts folder', () => {
    const { artifactsDirectoryOf, docsFolder } = setup();

    const directory = artifactsDirectoryOf('../../escape');

    expect(directory).toBe(join(realpathSync.native(docsFolder), 'artifacts', 'escape'));
  });
});

describe('a write judged against the artifact directory', () => {
  it('is allowed for the manager inside its directory and journaled with the actor', () => {
    const { write, artifactsDirectoryOf, entries } = setup();
    const filePath = join(artifactsDirectoryOf('Mnemosyne'), 'pr-body.md');

    const judgement = write({ filePath, content: 'hello' });

    expect(judgement).toEqual({ kind: 'allow' });
    expect(entries).toEqual([expect.objectContaining({ outcome: 'granted', sessionId: 'manager-session', actor: 'manager', managerName: 'Mnemosyne', path: filePath, bytes: 5 })]);
  });

  it('is allowed for a child of the manager, journaled as a child with its agent id', () => {
    const { write, artifactsDirectoryOf, entries } = setup();
    const filePath = join(artifactsDirectoryOf('Mnemosyne'), 'notes', 'x.md');

    const judgement = write({ filePath, content: 'hi', actor: CHILD_ACTOR });

    expect(judgement).toEqual({ kind: 'allow' });
    expect(entries[0]).toMatchObject({ outcome: 'granted', sessionId: 'child-session', actor: 'child', agentId: 'agent-7' });
  });

  it('has no opinion about a path outside the directory and journals nothing', () => {
    const { write, entries, docsFolder } = setup();

    const judgement = write({ filePath: join(docsFolder, 'specs', 'x.md'), content: 'hi' });

    expect(judgement).toEqual({ kind: 'not_in_artifacts' });
    expect(entries).toEqual([]);
  });

  it('has no opinion about the directory of another manager', () => {
    const { write, artifactsDirectoryOf } = setup();
    const otherManagerFile = join(artifactsDirectoryOf('Other'), 'x.md');

    expect(write({ filePath: otherManagerFile, content: 'hi', managerName: 'Mnemosyne' })).toEqual({ kind: 'not_in_artifacts' });
  });

  it('has no opinion about a relative path or a non-string path', () => {
    const { write } = setup();

    expect(write({ filePath: 'artifacts/Mnemosyne/x.md', content: 'hi' })).toEqual({ kind: 'not_in_artifacts' });
    expect(write({ filePath: 42, content: 'hi' })).toEqual({ kind: 'not_in_artifacts' });
  });

  it('is refused when the path climbs out with ..', () => {
    const { write, artifactsDirectoryOf, entries } = setup();
    const filePath = `${artifactsDirectoryOf('Mnemosyne')}/../../specs/x.md`;

    const judgement = write({ filePath, content: 'hi' });

    expect(judgement).toMatchObject({ kind: 'deny' });
    expect(entries).toEqual([expect.objectContaining({ outcome: 'refused' })]);
  });

  it('is refused when the path holds a NUL', () => {
    const { write, artifactsDirectoryOf } = setup();

    expect(write({ filePath: `${artifactsDirectoryOf('Mnemosyne')}/x\0.md`, content: 'hi' })).toMatchObject({ kind: 'deny' });
  });

  it('is refused when a symlink inside the directory leaves it', () => {
    const { write, artifactsDirectoryOf, entries } = setup();
    const directory = artifactsDirectoryOf('Mnemosyne');
    const outside = tempDirs.make('of-artifacts-outside-');
    symlinkSync(outside, join(directory, 'link'));

    const judgement = write({ filePath: join(directory, 'link', 'x.md'), content: 'hi' });

    expect(judgement).toMatchObject({ kind: 'deny' });
    expect(entries).toEqual([expect.objectContaining({ outcome: 'refused' })]);
  });

  it('is refused when the target file itself is a symlink, even to a file inside the directory', () => {
    const { write, artifactsDirectoryOf } = setup();
    const directory = artifactsDirectoryOf('Mnemosyne');
    writeFileSync(join(directory, 'real.md'), 'x');
    symlinkSync(join(directory, 'real.md'), join(directory, 'alias.md'));

    expect(write({ filePath: join(directory, 'alias.md'), content: 'hi' })).toMatchObject({ kind: 'deny' });
  });

  it('is refused when the file is above the maximum size', () => {
    const { write, artifactsDirectoryOf } = setup({ maxFileBytes: 10, maxProjectBytes: 1000 });

    const judgement = write({ filePath: join(artifactsDirectoryOf('Mnemosyne'), 'big.md'), content: 'x'.repeat(11) });

    expect(judgement).toMatchObject({ kind: 'deny', reason: expect.stringContaining('10') });
  });

  it('counts bytes, not characters', () => {
    const { write, artifactsDirectoryOf } = setup({ maxFileBytes: 10, maxProjectBytes: 1000 });

    expect(write({ filePath: join(artifactsDirectoryOf('Mnemosyne'), 'u.md'), content: 'é'.repeat(6) })).toMatchObject({ kind: 'deny' });
  });

  it('is refused when it would push the project over its quota, all managers counted', () => {
    const { write, artifactsDirectoryOf } = setup({ maxFileBytes: 100, maxProjectBytes: 150 });
    writeFileSync(join(artifactsDirectoryOf('Other'), 'a.md'), 'x'.repeat(100));

    const judgement = write({ filePath: join(artifactsDirectoryOf('Mnemosyne'), 'b.md'), content: 'x'.repeat(60) });

    expect(judgement).toMatchObject({ kind: 'deny', reason: expect.stringContaining('quota') });
  });

  it('counts an overwrite as a replacement, not an addition', () => {
    const { write, artifactsDirectoryOf } = setup({ maxFileBytes: 100, maxProjectBytes: 100 });
    const filePath = join(artifactsDirectoryOf('Mnemosyne'), 'a.md');
    writeFileSync(filePath, 'x'.repeat(90));

    expect(write({ filePath, content: 'y'.repeat(95) })).toEqual({ kind: 'allow' });
  });

  it('is refused when the content is not a string', () => {
    const { write, artifactsDirectoryOf } = setup();

    expect(write({ filePath: join(artifactsDirectoryOf('Mnemosyne'), 'x.md'), content: undefined })).toMatchObject({ kind: 'deny' });
  });

  it('is refused and journaled when the existing target is a hard link to another file', () => {
    const { write, artifactsDirectoryOf, entries } = setup();
    const directory = artifactsDirectoryOf('Mnemosyne');
    const outside = tempDirs.make('of-artifacts-outside-');
    writeFileSync(join(outside, 'precious.md'), 'x');
    linkSync(join(outside, 'precious.md'), join(directory, 'alias.md'));

    const judgement = write({ filePath: join(directory, 'alias.md'), content: 'hi' });

    expect(judgement).toMatchObject({ kind: 'deny', reason: expect.stringContaining('hard link') });
    expect(entries).toEqual([expect.objectContaining({ outcome: 'refused', path: join(directory, 'alias.md') })]);
  });

  it('has no opinion, and allows nothing, when the quota walk cannot read a folder', () => {
    const { write, artifactsDirectoryOf, entries } = setup();
    const unreadable = join(artifactsDirectoryOf('Other'), 'locked');
    mkdirSync(unreadable);
    chmodSync(unreadable, 0o000);

    try {
      const judgement = write({ filePath: join(artifactsDirectoryOf('Mnemosyne'), 'x.md'), content: 'hi' });

      expect(judgement).toEqual({ kind: 'not_in_artifacts' });
      expect(entries).toEqual([]);
    } finally {
      chmodSync(unreadable, 0o755);
    }
  });

  it('creates no folder for a path outside the artifacts folder', () => {
    const { write, docsFolder } = setup();

    const judgement = write({ filePath: join(docsFolder, 'specs', 'x.md'), content: 'hi' });

    expect(judgement).toEqual({ kind: 'not_in_artifacts' });
    expect(statSync(join(docsFolder, 'artifacts'), { throwIfNoEntry: false })).toBeUndefined();
  });

  it('is refused when the target is an existing directory', () => {
    const { write, artifactsDirectoryOf } = setup();
    const directory = artifactsDirectoryOf('Mnemosyne');
    mkdirSync(join(directory, 'sub'));

    expect(write({ filePath: join(directory, 'sub'), content: 'hi' })).toMatchObject({ kind: 'deny' });
  });
});
