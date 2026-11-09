import { z } from 'zod';
import { createGhRunner, parseGhJson, type GhProcessOptions } from './ghProcess.js';
import { requirePullRequestRef, type PullRequestRef } from './pullRequestRef.js';

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

export type GhPullRequestPortOptions = GhProcessOptions;

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

export const pullRequestStateSchema = z.enum(['OPEN', 'MERGED', 'CLOSED']);
export const headShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
export const checkOutcomesSchema = z.array(z.union([checkRunSchema, statusContextSchema]));

const pullRequestSchema = z.object({
  state: pullRequestStateSchema,
  headRefOid: headShaSchema,
  statusCheckRollup: checkOutcomesSchema,
}).transform(({ state, headRefOid, statusCheckRollup }): PullRequestSnapshot => ({ state, headSha: headRefOid, checkOutcomes: statusCheckRollup }));

/**
 * Reads a pull request through the user's GitHub CLI (`execFile`, fixed argument list, never a shell; see ghProcess.ts).
 *
 * - Failures are typed: gh_unavailable (missing binary), gh_not_authenticated (exit code 4), gh_timeout, gh_bad_output (anything else).
 */
export function createGhPullRequestPort(options: GhPullRequestPortOptions = {}): GhPullRequestPort {
  const runGh = createGhRunner(options);

  return {
    async snapshotOf(pullRequest) {
      const { repo, number } = requirePullRequestRef(pullRequest);
      const stdout = await runGh(['pr', 'view', String(number), '--repo', repo, '--json', JSON_FIELDS]);
      return parseGhJson(stdout, pullRequestSchema);
    },
  };
}
