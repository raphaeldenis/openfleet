import type { Session } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import {
  SHOW_CLOSED_STORAGE_KEY,
  childrenOfInList,
  closedSessionCountOf,
  groupByProject,
  readShowClosedPreference,
  rootsOfSessionList,
  writeShowClosedPreference,
} from './session-filter';

function session(overrides: Partial<Session> & { id: string }): Session {
  return { name: overrides.id, emoji: '🤖', directory: '/tmp', harness: 'fake', state: 'idle', stateSince: '', createdAt: '', ...overrides };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const idsOf = (sessions: Session[]) => sessions.map((s) => s.id);

describe('rootsOfSessionList', () => {
  it('hides closed sessions by default and reveals them with showClosed', () => {
    const sessions = [session({ id: 'live' }), session({ id: 'done', state: 'closed' })];

    expect(idsOf(rootsOfSessionList(sessions, { showClosed: false }))).toEqual(['live']);
    expect(idsOf(rootsOfSessionList(sessions, { showClosed: true }))).toEqual(['live', 'done']);
  });

  it('keeps a closed root that still has a live child', () => {
    const sessions = [session({ id: 'parent', state: 'closed' }), session({ id: 'child', parentId: 'parent' })];

    expect(idsOf(rootsOfSessionList(sessions, { showClosed: false }))).toEqual(['parent']);
  });

  it('never lists a closed manager and promotes its live child to a root', () => {
    const sessions = [session({ id: 'm', role: 'manager', state: 'closed' }), session({ id: 'child', parentId: 'm' })];

    expect(idsOf(rootsOfSessionList(sessions, { showClosed: true }))).toEqual(['child']);
  });

  it('keeps an open manager as a root', () => {
    const sessions = [session({ id: 'm', role: 'manager' })];

    expect(idsOf(rootsOfSessionList(sessions, { showClosed: false }))).toEqual(['m']);
  });
});

describe('childrenOfInList', () => {
  it('hides closed children unless showClosed', () => {
    const sessions = [session({ id: 'p' }), session({ id: 'a', parentId: 'p' }), session({ id: 'b', parentId: 'p', state: 'closed' })];

    expect(idsOf(childrenOfInList(sessions, 'p', { showClosed: false }))).toEqual(['a']);
    expect(idsOf(childrenOfInList(sessions, 'p', { showClosed: true }))).toEqual(['a', 'b']);
  });
});

describe('closedSessionCountOf', () => {
  it('counts closed sessions except closed managers', () => {
    const sessions = [session({ id: 'x', state: 'closed' }), session({ id: 'm', role: 'manager', state: 'closed' }), session({ id: 'y' })];

    expect(closedSessionCountOf(sessions)).toBe(1);
  });
});

describe('groupByProject', () => {
  const names = new Map([['p1', 'Zeta'], ['p2', 'Alpha']]);

  it('returns a single headerless group when no session has a project', () => {
    const groups = groupByProject([session({ id: 'a' })], names);

    expect(groups).toEqual([{ projectId: null, label: null, sessions: [expect.objectContaining({ id: 'a' })] }]);
  });

  it('orders projects by name and puts "No project" last', () => {
    const sessions = [session({ id: 'n' }), session({ id: 'z', projectId: 'p1' }), session({ id: 'a', projectId: 'p2' })];

    const groups = groupByProject(sessions, names);

    expect(groups.map((g) => g.label)).toEqual(['Alpha', 'Zeta', 'No project']);
  });

  it('labels a project whose name is unknown as "Unknown project"', () => {
    const groups = groupByProject([session({ id: 'a', projectId: 'gone' })], names);

    expect(groups[0].label).toBe('Unknown project');
  });
});

describe('show closed preference', () => {
  it('defaults to off', () => {
    expect(readShowClosedPreference(() => memoryStorage())).toBe(false);
  });

  it('round-trips through storage', () => {
    const storage = memoryStorage();

    writeShowClosedPreference(true, () => storage);

    expect(readShowClosedPreference(() => storage)).toBe(true);
    expect(storage.getItem(SHOW_CLOSED_STORAGE_KEY)).toBe('1');
  });

  it('falls back to off when storage throws', () => {
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };

    expect(readShowClosedPreference(() => throwing)).toBe(false);
    expect(() => writeShowClosedPreference(true, () => throwing)).not.toThrow();
  });
});
