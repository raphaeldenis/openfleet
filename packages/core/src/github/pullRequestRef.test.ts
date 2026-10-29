import { describe, expect, it } from 'vitest';
import { requirePullRequestRef } from './pullRequestRef.js';

const MAX_OWNER_LENGTH = 39;
const MAX_NAME_LENGTH = 100;

describe('the pull request reference', () => {
  it('accepts an owner of 39 characters and a name of 100 characters', () => {
    const repo = `${'a'.repeat(MAX_OWNER_LENGTH)}/${'b'.repeat(MAX_NAME_LENGTH)}`;

    expect(requirePullRequestRef({ repo, number: 7 })).toEqual({ repo, number: 7 });
  });

  it.each([
    ['an owner of 40 characters', `${'a'.repeat(MAX_OWNER_LENGTH + 1)}/widgets`],
    ['a name of 101 characters', `acme/${'b'.repeat(MAX_NAME_LENGTH + 1)}`],
    ['a 200 kB owner', `${'a'.repeat(200_000)}/b`],
  ])('refuses %s with invalid_body', (_label, repo) => {
    const requireRef = () => requirePullRequestRef({ repo, number: 7 });

    expect(requireRef).toThrow(expect.objectContaining({ code: 'invalid_body' }));
  });
});
