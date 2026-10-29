import { execFile } from 'node:child_process';
import { OpenFleetError } from '@openfleet/shared';
import { z } from 'zod';
import { requirePullRequestRef, type PullRequestRef } from './pullRequestRef.js';

const GH_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const GH_EXIT_CODE_AUTHENTICATION_REQUIRED = 4;
const JSON_FIELDS = 'state,headRefOid,statusCheckRollup';

export type PullRequestState = 'OPEN' | 'MERGED' | 'CLOSED';
export type CheckOutcome = 'success' | 'failure' | 'pending';

/** What the daemon keeps of a pull request: no check name, no log, only enumerated values and the head sha. */
export interface PullRequestSnapshot {
  state: PullRequestState;
  headSha: string;
  checkOutcomes: CheckOutcome[];
}

export interface GhPullRequestPort {
  snapshotOf(pullRequest: PullRequestRef): Promise<PullRequestSnapshot>;
}

export interface GhPullRequestPortOptions {
  ghExecutable?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

const SUCCESSFUL_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

const checkRunOutcomeOf = ({ status, conclusion }: { status: string; conclusion: string }): CheckOutcome => {
  if (status !== 'COMPLETED') return 'pending';
  return SUCCESSFUL_CONCLUSIONS.has(conclusion) ? 'success' : 'failure';
};

const statusContextOutcomeOf = (state: string): CheckOutcome => {
  if (state === 'SUCCESS') return 'success';
  const isWaiting = state === 'PENDING' || state === 'EXPECTED';
  return isWaiting ? 'pending' : 'failure';
};

const checkRunSchema = z.object({ __typename: z.literal('CheckRun'), status: z.string(), conclusion: z.string() }).transform(checkRunOutcomeOf);
const statusContextSchema = z.object({ __typename: z.literal('StatusContext'), state: z.string() }).transform(({ state }) => statusContextOutcomeOf(state));

const pullRequestSchema = z.object({
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/),
  statusCheckRollup: z.array(z.union([checkRunSchema, statusContextSchema])),
}).transform(({ state, headRefOid, statusCheckRollup }): PullRequestSnapshot => ({ state, headSha: headRefOid, checkOutcomes: statusCheckRollup }));

const badOutput = (hint: string) => new OpenFleetError('gh_bad_output', 'the GitHub CLI answered something the daemon cannot read.', { hint });

/**
 * Reads a pull request through the user's GitHub CLI (`execFile`, fixed argument list, never a shell).
 *
 * - gh gets only PATH, HOME and non-interactive switches: the daemon environment never reaches it, and the daemon reads no token.
 * - Failures are typed: gh_unavailable (missing binary), gh_not_authenticated (exit code 4), gh_timeout, gh_bad_output (anything else).
 */
export function createGhPullRequestPort(options: GhPullRequestPortOptions = {}): GhPullRequestPort {
  const { ghExecutable = 'gh', timeoutMs = GH_TIMEOUT_MS, maxBufferBytes = MAX_OUTPUT_BYTES } = options;

  const runGh = (argv: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = execFile(ghExecutable, argv, {
        env: minimalGhEnvironment(),
        encoding: 'utf8',
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: maxBufferBytes,
      }, (error, stdout) => (error ? reject(ghFailureOf(error)) : resolve(stdout)));
      child.stdin?.end();
    });

  return {
    async snapshotOf(pullRequest) {
      const { repo, number } = requirePullRequestRef(pullRequest);
      const stdout = await runGh(['pr', 'view', String(number), '--repo', repo, '--json', JSON_FIELDS]);
      return parseSnapshot(stdout);
    },
  };
}

function parseSnapshot(stdout: string): PullRequestSnapshot {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw badOutput('gh did not print JSON; update gh and retry.');
  }
  const parsed = pullRequestSchema.safeParse(json);
  if (!parsed.success) throw badOutput('gh printed JSON of an unexpected shape; update gh and retry.');
  return parsed.data;
}

/** What execFile reports: a string `code` for a system error, a number for an exit status, `killed` when the timeout stopped the process. */
type GhProcessError = Error & { code?: string | number; killed?: boolean };

function ghFailureOf(error: GhProcessError): OpenFleetError {
  const isMissingBinary = error.code === 'ENOENT' || error.code === 'EACCES';
  if (isMissingBinary) return new OpenFleetError('gh_unavailable', 'the GitHub CLI is not available to the daemon.', { hint: 'install gh, or start the daemon from a shell where gh runs.' });
  if (error.killed) return new OpenFleetError('gh_timeout', 'the GitHub CLI took too long to answer.', { hint: 'the daemon polls again later.' });
  if (error.code === GH_EXIT_CODE_AUTHENTICATION_REQUIRED) return new OpenFleetError('gh_not_authenticated', 'the GitHub CLI is not signed in.', { hint: 'run `gh auth login` in a terminal.' });
  return badOutput('gh exited with an error; check the repository, the pull request number and your access.');
}

function minimalGhEnvironment(): NodeJS.ProcessEnv {
  const { PATH, HOME } = process.env;
  return {
    ...(PATH === undefined ? {} : { PATH }),
    ...(HOME === undefined ? {} : { HOME }),
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
  };
}
