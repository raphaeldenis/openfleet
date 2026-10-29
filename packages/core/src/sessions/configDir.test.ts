import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { configProfileOf, resolveConfigDir } from './configDir.js';

const SCRATCH_ROOT = join(process.cwd(), '.scratch');

let home: string;
let outside: string;

beforeEach(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  home = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'of-home-')));
  outside = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'of-outside-')));
});

const makeDirectoryInHome = (relativePath: string): string => {
  const path = join(home, relativePath);
  mkdirSync(path, { recursive: true });
  return path;
};

describe('resolveConfigDir', () => {
  it('returns the real path of an existing directory under the home directory', () => {
    const profile = makeDirectoryInHome('.claude-work');

    expect(resolveConfigDir({ requested: profile, homeDirectory: home })).toEqual({ realPath: profile });
  });

  it('resolves a symlink that stays under the home directory to its target', () => {
    const target = makeDirectoryInHome('.claude-real');
    const link = join(home, '.claude-link');
    symlinkSync(target, link);

    expect(resolveConfigDir({ requested: link, homeDirectory: home })).toEqual({ realPath: target });
  });

  it('refuses a relative path', () => {
    makeDirectoryInHome('.claude-work');

    expect(resolveConfigDir({ requested: '.claude-work', homeDirectory: home })).toEqual({ refusal: 'config_dir must be an absolute path' });
  });

  it('refuses a path that does not exist', () => {
    expect(resolveConfigDir({ requested: join(home, '.nope'), homeDirectory: home })).toEqual({ refusal: 'config_dir does not exist or is not a directory' });
  });

  it('refuses a path that is a file', () => {
    const file = join(home, '.claude-file');
    writeFileSync(file, 'synthetic');

    expect(resolveConfigDir({ requested: file, homeDirectory: home })).toEqual({ refusal: 'config_dir does not exist or is not a directory' });
  });

  it('refuses a directory outside the home directory', () => {
    expect(resolveConfigDir({ requested: outside, homeDirectory: home })).toEqual({ refusal: 'config_dir must be inside the home directory' });
  });

  it('refuses the home directory itself', () => {
    expect(resolveConfigDir({ requested: home, homeDirectory: home })).toEqual({ refusal: 'config_dir must be inside the home directory' });
  });

  it('refuses a symlink under the home directory that points outside it', () => {
    const link = join(home, '.claude-escape');
    symlinkSync(outside, link);

    expect(resolveConfigDir({ requested: link, homeDirectory: home })).toEqual({ refusal: 'config_dir must be inside the home directory' });
  });

  it('refuses a ".." path that lexically starts under home but resolves outside it', () => {
    makeDirectoryInHome('.claude-work');
    const escaping = `${home}/.claude-work/../../${outside.split('/').pop()}`;

    expect(resolveConfigDir({ requested: escaping, homeDirectory: home })).toEqual({ refusal: 'config_dir must be inside the home directory' });
  });

  it('refuses the default ~/.claude directory itself', () => {
    const defaultProfile = makeDirectoryInHome('.claude');

    expect(resolveConfigDir({ requested: defaultProfile, homeDirectory: home })).toEqual({ refusal: 'config_dir must not be the default ~/.claude directory' });
  });

  it('refuses a symlink that resolves to the default ~/.claude directory', () => {
    const defaultProfile = makeDirectoryInHome('.claude');
    const link = join(home, '.claude-alias');
    symlinkSync(defaultProfile, link);

    expect(resolveConfigDir({ requested: link, homeDirectory: home })).toEqual({ refusal: 'config_dir must not be the default ~/.claude directory' });
  });

  it('refuses the OpenFleet state directory ~/.openfleet', () => {
    const state = makeDirectoryInHome('.openfleet');

    expect(resolveConfigDir({ requested: state, homeDirectory: home })).toEqual({ refusal: 'config_dir must not be the OpenFleet state directory' });
  });

  it('accepts a sibling whose name merely starts with ".claude"', () => {
    const profile = makeDirectoryInHome('.claude-personal');

    expect(resolveConfigDir({ requested: profile, homeDirectory: home })).toEqual({ realPath: profile });
  });

  describe('when ~/.claude and ~/.openfleet are symlinks into a dotfiles folder', () => {
    const defaultProfileRefusal = { refusal: 'config_dir must not be the default ~/.claude directory' };
    const stateRefusal = { refusal: 'config_dir must not be the OpenFleet state directory' };

    beforeEach(() => {
      makeDirectoryInHome('dotfiles/claude');
      makeDirectoryInHome('dotfiles/of');
      symlinkSync(join(home, 'dotfiles/claude'), join(home, '.claude'));
      symlinkSync(join(home, 'dotfiles/of'), join(home, '.openfleet'));
    });

    it.each([
      ['the ~/.claude link', '.claude'],
      ['the real folder behind ~/.claude', 'dotfiles/claude'],
    ])('refuses %s', (_label, relativePath) => {
      expect(resolveConfigDir({ requested: join(home, relativePath), homeDirectory: home })).toEqual(defaultProfileRefusal);
    });

    it.each([
      ['the ~/.openfleet link', '.openfleet'],
      ['the real folder behind ~/.openfleet', 'dotfiles/of'],
    ])('refuses %s', (_label, relativePath) => {
      expect(resolveConfigDir({ requested: join(home, relativePath), homeDirectory: home })).toEqual(stateRefusal);
    });

    it('refuses a subfolder of the real folder behind ~/.openfleet', () => {
      const state = makeDirectoryInHome('dotfiles/of/db');

      expect(resolveConfigDir({ requested: state, homeDirectory: home })).toEqual(stateRefusal);
    });
  });

  it('refuses ~/.CLAUDE spelled with another case', () => {
    makeDirectoryInHome('.claude');
    const shoutedProfile = makeDirectoryInHome('.CLAUDE');

    expect(resolveConfigDir({ requested: shoutedProfile, homeDirectory: home })).toEqual({ refusal: 'config_dir must not be the default ~/.claude directory' });
  });

  it('refuses a subfolder of ~/.openfleet', () => {
    const state = makeDirectoryInHome('.openfleet/x');

    expect(resolveConfigDir({ requested: state, homeDirectory: home })).toEqual({ refusal: 'config_dir must not be the OpenFleet state directory' });
  });

  it('accepts a profile under ~/.claude, only the folder itself being refused', () => {
    const profile = makeDirectoryInHome('.claude/profiles/x');

    expect(resolveConfigDir({ requested: profile, homeDirectory: home })).toEqual({ realPath: profile });
  });

  it('refuses the folder named by OPENFLEET_HOME and anything under it, inside the home directory', () => {
    const customState = makeDirectoryInHome('custom-state/db');

    expect(resolveConfigDir({ requested: customState, homeDirectory: home, openfleetHome: join(home, 'custom-state') })).toEqual({ refusal: 'config_dir must not be the OpenFleet state directory' });
  });

  it('refuses a symlink to the folder named by OPENFLEET_HOME', () => {
    const customState = makeDirectoryInHome('custom-state');
    const link = join(home, 'state-alias');
    symlinkSync(customState, link);

    expect(resolveConfigDir({ requested: link, homeDirectory: home, openfleetHome: customState })).toEqual({ refusal: 'config_dir must not be the OpenFleet state directory' });
  });

  it('refuses the OPENFLEET_HOME folder reached through a symlink given as OPENFLEET_HOME', () => {
    const customState = makeDirectoryInHome('custom-state');
    const link = join(home, 'state-alias');
    symlinkSync(customState, link);

    expect(resolveConfigDir({ requested: customState, homeDirectory: home, openfleetHome: link })).toEqual({ refusal: 'config_dir must not be the OpenFleet state directory' });
  });

  it('keeps accepting a profile when OPENFLEET_HOME is outside the home directory', () => {
    const profile = makeDirectoryInHome('.claude-work');

    expect(resolveConfigDir({ requested: profile, homeDirectory: home, openfleetHome: outside })).toEqual({ realPath: profile });
  });

  it('compares lexically when the forbidden folders do not exist', () => {
    const profile = makeDirectoryInHome('.claude-work');

    expect(resolveConfigDir({ requested: profile, homeDirectory: home, openfleetHome: join(home, 'missing-state') })).toEqual({ realPath: profile });
  });
});

describe('configProfileOf', () => {
  it('returns the last path segment as the profile name', () => {
    expect(configProfileOf('/Users/someone/.claude-work')).toBe('.claude-work');
  });
});
