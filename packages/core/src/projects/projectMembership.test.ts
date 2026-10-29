import { describe, expect, it, vi } from 'vitest';
import { isDirectoryInProject, MAX_REPOSITORY_CHECKS } from './projectMembership.js';

const neverTheSameRepository = () => vi.fn().mockResolvedValue(false);

describe('isDirectoryInProject', () => {
  it('accepts a directory that is the directory of a project session', async () => {
    const sameGitRepository = neverTheSameRepository();

    const isInProject = await isDirectoryInProject({ realDirectory: '/repo/app', projectDirectories: ['/repo/app'], docsFolderPath: null, sameGitRepository });

    expect(isInProject).toBe(true);
    expect(sameGitRepository).not.toHaveBeenCalled();
  });

  it('accepts a subdirectory of a project session directory', async () => {
    const isInProject = await isDirectoryInProject({ realDirectory: '/repo/app/packages/ui', projectDirectories: ['/repo/app'], docsFolderPath: null, sameGitRepository: neverTheSameRepository() });

    expect(isInProject).toBe(true);
  });

  it('accepts a directory that contains a project session directory', async () => {
    const isInProject = await isDirectoryInProject({ realDirectory: '/repo', projectDirectories: ['/repo/app'], docsFolderPath: null, sameGitRepository: neverTheSameRepository() });

    expect(isInProject).toBe(true);
  });

  it('accepts the docs folder of the project and what is inside it', async () => {
    const isInProject = await isDirectoryInProject({ realDirectory: '/docs/openfleet/specs', projectDirectories: [], docsFolderPath: '/docs/openfleet', sameGitRepository: neverTheSameRepository() });

    expect(isInProject).toBe(true);
  });

  it('accepts a new worktree of the git repository of a project session', async () => {
    const sameGitRepository = vi.fn(async (known: string) => known === '/repo/app');

    const isInProject = await isDirectoryInProject({ realDirectory: '/worktrees/feature-x', projectDirectories: ['/other', '/repo/app'], docsFolderPath: null, sameGitRepository });

    expect(isInProject).toBe(true);
  });

  it('refuses a directory unrelated to every project directory', async () => {
    const isInProject = await isDirectoryInProject({ realDirectory: '/elsewhere/tmp', projectDirectories: ['/repo/app'], docsFolderPath: '/docs/openfleet', sameGitRepository: neverTheSameRepository() });

    expect(isInProject).toBe(false);
  });

  it('refuses every directory of a project that has no session directory and no docs folder', async () => {
    const isInProject = await isDirectoryInProject({ realDirectory: '/repo/app', projectDirectories: [], docsFolderPath: null, sameGitRepository: neverTheSameRepository() });

    expect(isInProject).toBe(false);
  });

  it('does not take a sibling whose name starts with a project directory name for a subdirectory', async () => {
    const isInProject = await isDirectoryInProject({ realDirectory: '/repo/app-copy', projectDirectories: ['/repo/app'], docsFolderPath: null, sameGitRepository: neverTheSameRepository() });

    expect(isInProject).toBe(false);
  });

  it('checks each distinct project directory once and stops after the repository check cap', async () => {
    const sameGitRepository = neverTheSameRepository();
    const manyDirectories = Array.from({ length: MAX_REPOSITORY_CHECKS + 5 }, (_, index) => `/repo/app-${index}`);

    await isDirectoryInProject({ realDirectory: '/elsewhere', projectDirectories: [...manyDirectories, ...manyDirectories], docsFolderPath: null, sameGitRepository });

    expect(sameGitRepository).toHaveBeenCalledTimes(MAX_REPOSITORY_CHECKS);
  });
});
