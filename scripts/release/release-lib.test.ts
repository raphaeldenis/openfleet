import { describe, expect, it } from 'vitest';
import { compareVersions, groupCommits, parseConventionalSubject, parseSemver, renderReleaseNotes } from './release-lib.mjs';

describe('parseSemver', () => {
  it.each(['0.1.0', '1.2.3', '10.20.30', '1.0.0-beta.1', '1.0.0-0.3.7', '1.0.0+build.5', '1.0.0-rc.1+build.5'])('accepts %s', (version) => {
    expect(parseSemver(version)).not.toBeNull();
  });

  it.each(['', '1', '1.2', 'v1.2.3', '01.2.3', '1.2.3-', '1.2.3+', '1.2.3-01', 'garbage'])('refuses "%s"', (version) => {
    expect(parseSemver(version)).toBeNull();
  });
});

describe('compareVersions', () => {
  it.each([
    ['0.2.0', '0.1.0', 1],
    ['0.1.0', '0.2.0', -1],
    ['0.1.0', '0.1.0', 0],
    ['0.10.0', '0.9.0', 1],
    ['1.0.0', '1.0.0-rc.1', 1],
    ['1.0.0-rc.1', '1.0.0', -1],
    ['1.0.0-beta.2', '1.0.0-beta.11', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-1', '1.0.0-alpha', -1],
    ['1.0.0-beta', '1.0.0-alpha', 1],
    ['1.0.0+a', '1.0.0+b', 0],
  ])('compares %s with %s as %i', (left, right, expected) => {
    expect(compareVersions(left, right)).toBe(expected);
  });
});

describe('parseConventionalSubject', () => {
  it('splits type, scope and description', () => {
    expect(parseConventionalSubject('feat(core): add a thing')).toEqual({ type: 'feat', scope: 'core', isBreaking: false, description: 'add a thing' });
  });

  it('reads the breaking marker and a missing scope', () => {
    expect(parseConventionalSubject('fix!: drop the old api')).toEqual({ type: 'fix', scope: null, isBreaking: true, description: 'drop the old api' });
  });

  it('returns null for a free-form subject', () => {
    expect(parseConventionalSubject('Merge pull request #47 from x/y')).toBeNull();
  });
});

describe('groupCommits', () => {
  const commits = [
    { hash: 'a1', subject: 'fix(core): stop the leak' },
    { hash: 'b2', subject: 'feat(desktop): add dark mode' },
    { hash: 'c3', subject: 'refactor!: rename the port' },
    { hash: 'd4', subject: 'Update the readme' },
    { hash: 'e5', subject: 'chore(release): v0.1.0' },
    { hash: 'f6', subject: 'feat: second feature' },
  ];

  it('orders groups with breaking changes first and other changes last, and skips empty groups', () => {
    const headings = groupCommits(commits).map(({ heading }) => heading);

    expect(headings).toEqual(['Breaking changes', 'Features', 'Fixes', 'Other changes']);
  });

  it('keeps commits of one group in the given order, with the scope in bold', () => {
    const features = groupCommits(commits).find(({ heading }) => heading === 'Features');

    expect(features?.entries).toEqual([
      { hash: 'b2', text: '**desktop:** add dark mode' },
      { hash: 'f6', text: 'second feature' },
    ]);
  });

  it('keeps a non-conventional subject verbatim under other changes', () => {
    const other = groupCommits(commits).find(({ heading }) => heading === 'Other changes');

    expect(other?.entries).toEqual([{ hash: 'd4', text: 'Update the readme' }]);
  });

  it('skips the chore(release) bookkeeping commits', () => {
    const allHashes = groupCommits(commits).flatMap(({ entries }) => entries.map(({ hash }) => hash));

    expect(allHashes).not.toContain('e5');
  });

  it('returns no group for no commit', () => {
    expect(groupCommits([])).toEqual([]);
  });
});

describe('renderReleaseNotes', () => {
  const groups = [{ heading: 'Features', entries: [{ hash: 'b2', text: '**desktop:** add dark mode' }] }];

  it('renders the title, the summary to write, the range and each group', () => {
    const notes = renderReleaseNotes({ version: '0.2.0', date: '2026-10-04', previousTag: 'v0.1.0', groups });

    expect(notes).toBe(
      '# OpenFleet v0.2.0 (2026-10-04)\n\nSummary: TODO write two lines for the people who install this build.\n\n1 commits since v0.1.0.\n\n## Features\n- **desktop:** add dark mode (b2)\n',
    );
  });

  it('says there is no previous tag when there is none', () => {
    const notes = renderReleaseNotes({ version: '0.1.0', date: '2026-10-04', previousTag: null, groups });

    expect(notes).toContain('since the first commit (no previous tag)');
  });
});
