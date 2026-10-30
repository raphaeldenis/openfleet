import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirTracker } from '../tempDirTracker.js';
import { createArbiterWorkspaces } from './arbiterWorkspaces.js';

const directories = createTempDirTracker();
afterEach(() => directories.removeAll());

const aWorkspaces = () => {
  const outside = directories.make('arbiter-outside-');
  const root = join(directories.make('arbiter-home-'), 'arbiter-workspaces');
  return { workspaces: createArbiterWorkspaces(root), root, outside };
};

describe('createArbiterWorkspaces', () => {
  it('creates an empty directory under the root that only its owner can use', () => {
    const { workspaces } = aWorkspaces();

    const workspace = workspaces.create();

    expect(readdirSync(workspace)).toEqual([]);
    expect(statSync(workspace).mode & 0o777).toBe(0o700);
  });

  it('creates a different directory each time', () => {
    const { workspaces } = aWorkspaces();

    expect(workspaces.create()).not.toBe(workspaces.create());
  });

  it('removes a workspace with its content', () => {
    const { workspaces } = aWorkspaces();
    const workspace = workspaces.create();
    writeFileSync(join(workspace, 'CLAUDE.md'), 'x');

    workspaces.remove(workspace);

    expect(existsSync(workspace)).toBe(false);
  });

  it('removes nothing that is not a workspace of the root', () => {
    const { workspaces, outside } = aWorkspaces();
    workspaces.create();
    const worktree = join(outside, 'worktree');
    mkdirSync(worktree);

    workspaces.remove(worktree);
    workspaces.remove(outside);

    expect(existsSync(worktree)).toBe(true);
  });

  it('removes every workspace but the ones to keep', () => {
    const { workspaces } = aWorkspaces();
    const kept = workspaces.create();
    const dropped = workspaces.create();

    workspaces.removeAllExcept(new Set([kept]));

    expect(existsSync(kept)).toBe(true);
    expect(existsSync(dropped)).toBe(false);
  });

  it('sweeps nothing when the root does not exist yet', () => {
    const { workspaces, root } = aWorkspaces();

    expect(() => workspaces.removeAllExcept(new Set())).not.toThrow();
    expect(existsSync(root)).toBe(false);
  });
});
