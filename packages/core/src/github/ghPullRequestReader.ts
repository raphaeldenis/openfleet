import { OpenFleetError } from '@openfleet/shared';
import { z } from 'zod';
import { checkOutcomesSchema, headShaSchema, pullRequestStateSchema, type CheckOutcome, type PullRequestState } from './ghPullRequestPort.js';
import { createGhRunner, parseGhJson, type GhProcessOptions } from './ghProcess.js';
import { isRepository, pullRequestUrlOf, requirePullRequestRef, requireRepository, type PullRequestRef } from './pullRequestRef.js';

export const MAX_LISTED_PULL_REQUESTS = 50;
export const MAX_TEXT_LENGTH = 200;

const SEARCH_FIELDS = 'number,title,repository,author,isDraft,url';
const DETAIL_FIELDS = 'number,title,state,isDraft,author,headRefName,baseRefName,headRefOid,url,reviewDecision,statusCheckRollup';
const FLAG_BY_FILTER = { review_requested: '--review-requested=@me', authored: '--author=@me' } as const;
const CHARACTERS_THAT_CAN_FORGE_STRUCTURE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export type PullRequestFilter = keyof typeof FLAG_BY_FILTER;

export interface PullRequestQuery {
  filter: PullRequestFilter;
  repo?: string;
  limit: number;
}

/** A listed pull request. `title` and `author` are free text written by other people: the caller treats them as untrusted. */
export interface ListedPullRequest {
  repo: string;
  number: number;
  url: string;
  title: string;
  author: string;
  isDraft: boolean;
}

/** One pull request in detail: no body, no check name, no comment. `title`, `author` and the branch names are untrusted free text. */
export interface PullRequestDetail extends ListedPullRequest {
  state: PullRequestState;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  reviewDecision: string | null;
  checkOutcomes: CheckOutcome[];
}

export interface GhPullRequestReader {
  listFor(query: PullRequestQuery): Promise<ListedPullRequest[]>;
  detailOf(pullRequest: PullRequestRef): Promise<PullRequestDetail>;
}

const boundedTextSchema = z.string().transform((text) => [...text.replace(CHARACTERS_THAT_CAN_FORGE_STRUCTURE, '')].slice(0, MAX_TEXT_LENGTH).join(''));
const repositorySchema = z.string().refine(isRepository);
const loginSchema = z.object({ login: boundedTextSchema }).transform(({ login }) => login);

const searchedPullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: boundedTextSchema,
  repository: z.object({ nameWithOwner: repositorySchema }),
  author: loginSchema,
  isDraft: z.boolean(),
}).transform(({ number, title, repository, author, isDraft }): ListedPullRequest => {
  const repo = repository.nameWithOwner;
  return { repo, number, url: pullRequestUrlOf({ repo, number }), title, author, isDraft };
});
const searchResultsSchema = z.array(searchedPullRequestSchema);

const detailSchema = z.object({
  title: boundedTextSchema,
  state: pullRequestStateSchema,
  isDraft: z.boolean(),
  author: loginSchema,
  headRefName: boundedTextSchema,
  baseRefName: boundedTextSchema,
  headRefOid: headShaSchema,
  reviewDecision: z.string(),
  statusCheckRollup: checkOutcomesSchema,
});

const invalidBody = (message: string, hint: string) => new OpenFleetError('invalid_body', message, { hint });

function requireQuery({ filter, repo, limit }: PullRequestQuery): void {
  const isKnownFilter = Object.hasOwn(FLAG_BY_FILTER, filter);
  if (!isKnownFilter) throw invalidBody('filter is not known.', 'use review_requested or authored.');
  if (repo !== undefined) requireRepository(repo);
  const isLimitInRange = Number.isInteger(limit) && limit >= 1 && limit <= MAX_LISTED_PULL_REQUESTS;
  if (!isLimitInRange) throw invalidBody('limit is out of range.', `give a whole number from 1 to ${MAX_LISTED_PULL_REQUESTS}.`);
}

/**
 * Reads pull requests through the user's GitHub CLI: `gh search prs` for a list, `gh pr view` for one.
 * Same process rules as GhPullRequestPort (separate arguments, no shell, reduced environment, no token read, bounded output);
 * every answer is checked by a schema and text fields are length-capped and stripped of control characters.
 */
export function createGhPullRequestReader(options: GhProcessOptions = {}): GhPullRequestReader {
  const runGh = createGhRunner(options);

  return {
    async listFor(query) {
      requireQuery(query);
      const repoScope = query.repo === undefined ? [] : [`--repo=${query.repo}`];
      const argv = ['search', 'prs', FLAG_BY_FILTER[query.filter], '--state=open', ...repoScope, `--limit=${query.limit}`, '--json', SEARCH_FIELDS];
      const listed = parseGhJson(await runGh(argv), searchResultsSchema);
      return listed.slice(0, query.limit);
    },

    async detailOf(pullRequest) {
      const { repo, number } = requirePullRequestRef(pullRequest);
      const stdout = await runGh(['pr', 'view', '--repo', repo, '--json', DETAIL_FIELDS, '--', String(number)]);
      const detail = parseGhJson(stdout, detailSchema);
      const hasReviewDecision = detail.reviewDecision !== '';
      return {
        repo, number, url: pullRequestUrlOf({ repo, number }), title: detail.title, author: detail.author, isDraft: detail.isDraft,
        state: detail.state, headBranch: detail.headRefName, baseBranch: detail.baseRefName, headSha: detail.headRefOid,
        reviewDecision: hasReviewDecision ? detail.reviewDecision : null, checkOutcomes: detail.statusCheckRollup,
      };
    },
  };
}
