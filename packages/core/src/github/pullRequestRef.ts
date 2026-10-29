import { OpenFleetError } from '@openfleet/shared';

const MAX_OWNER_LENGTH = 39;
const MAX_NAME_LENGTH = 100;
const REPOSITORY_PATTERN = new RegExp(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,${MAX_OWNER_LENGTH - 1}}/[A-Za-z0-9_][A-Za-z0-9_.-]{0,${MAX_NAME_LENGTH - 1}}$`);
const MAX_PULL_REQUEST_NUMBER = 2 ** 31 - 1;

export interface PullRequestRef {
  repo: string;
  number: number;
}

/** Returns the pull request reference when it is safe to hand to gh as arguments; throws invalid_body otherwise. */
export function requirePullRequestRef({ repo, number }: PullRequestRef): PullRequestRef {
  const isRepository = REPOSITORY_PATTERN.test(repo);
  if (!isRepository) throw new OpenFleetError('invalid_body', 'repo is not an owner/name GitHub repository.', { hint: 'use the form owner/name, e.g. acme/widgets.' });
  const isPullRequestNumber = Number.isInteger(number) && number >= 1 && number <= MAX_PULL_REQUEST_NUMBER;
  if (!isPullRequestNumber) throw new OpenFleetError('invalid_body', 'number is not a pull request number.', { hint: 'give a positive integer.' });
  return { repo, number };
}

/** The address of the pull request, rebuilt from the validated reference. */
export const pullRequestUrlOf = ({ repo, number }: PullRequestRef): string => `https://github.com/${repo}/pull/${number}`;
