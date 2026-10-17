import { run } from '../git/worktrees.js';

const GIT_TIMEOUT_MS = 10_000;

/** The trimmed output of a git command run in a directory, or undefined when git fails there. */
export async function gitOutput(args: string[], directory: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(args, { cwd: directory, timeoutMs: GIT_TIMEOUT_MS });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export const DEFAULT_TICKET_PATTERN = '[A-Z][A-Z0-9]+-\\d+';

/** The ticket a branch is named after, or undefined when its name carries none. */
export function ticketOfBranch({ branch, ticketPattern }: { branch: string | undefined; ticketPattern: string }): string | undefined {
  return branch?.match(new RegExp(ticketPattern))?.[0];
}
