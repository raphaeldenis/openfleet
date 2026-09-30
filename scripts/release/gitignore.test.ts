import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const isIgnoredByGit = (path: string) => spawnSync('git', ['check-ignore', '-q', path], { cwd: REPO_ROOT }).status === 0;

describe('build outputs of the desktop app', () => {
  it.each([
    'apps/desktop/src-tauri/resources/daemon/daemon.mjs',
    'apps/desktop/src-tauri/binaries/openfleet-daemon-aarch64-apple-darwin',
    'apps/desktop/src-tauri/target/debug/openfleet',
    'scripts/.vitest/json/output.json',
  ])('are ignored by git: %s', (path) => {
    expect(isIgnoredByGit(path)).toBe(true);
  });
});
