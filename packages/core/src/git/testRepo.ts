import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnvironmentForGit } from '../process/childEnvironment.js';

export function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'of-repo-'));
  const env = childEnvironmentForGit(process.env);
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, env });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: dir, env });
  return dir;
}
