import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { OpenFleetError } from '@openfleet/shared';
import { unstartableReasonOf } from '../git/scriptProcess.js';

export interface LocatedScript {
  /** The program as the cell names it. */
  program: string;
  /** The real path of the file, inside a script root; this is the path that is started. */
  path: string;
  sha256: string;
}

const TEMPLATE_START = '{{';

const refusal = (program: string, reason: string) => new OpenFleetError('script_not_allowed', `the program "${program}" is not allowed: ${reason}.`);

const realpathOrUndefined = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

/**
 * Finds the file a script cell names, under the script roots only.
 * A program is a literal path (a token cannot be pinned by an approval), relative to a root or absolute inside one; the real path, after symlinks, stays inside the root.
 * The file must be one the daemon may start: owned by its user, not writable by group or others, executable.
 * The hash is read at the time of the call: a file can still change between the call and the start of the process, which is why the owner and permissions are checked too.
 */
export class ScriptLocator {
  constructor(private readonly roots: readonly string[]) {}

  /** Throws script_not_allowed when no root holds the program or the file is unsafe to start. */
  locate(program: string): LocatedScript {
    const isTemplate = program.includes(TEMPLATE_START);
    if (isTemplate) throw refusal(program, 'a program is a literal path: an approval cannot pin a token');
    const hasNoRoot = this.roots.length === 0;
    if (hasNoRoot) throw refusal(program, 'no script root is configured');

    const path = this.realPathUnderARoot(program);
    if (path === undefined) throw refusal(program, 'no script root holds this file');
    const unstartableReason = unstartableReasonOf(path);
    if (unstartableReason !== undefined) throw refusal(program, `the file cannot be started safely (${unstartableReason})`);
    return { program, path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  }

  /** The located script, or undefined when `locate` would throw. */
  tryLocate(program: string): LocatedScript | undefined {
    try {
      return this.locate(program);
    } catch (error) {
      if (error instanceof OpenFleetError && error.code === 'script_not_allowed') return undefined;
      throw error;
    }
  }

  private realPathUnderARoot(program: string): string | undefined {
    for (const root of this.roots) {
      const realRoot = realpathOrUndefined(root);
      if (realRoot === undefined) continue;
      const realPath = realpathOrUndefined(resolve(realRoot, program));
      const isInsideTheRoot = realPath !== undefined && realPath.startsWith(realRoot + sep);
      if (isInsideTheRoot) return realPath;
    }
    return undefined;
  }
}
