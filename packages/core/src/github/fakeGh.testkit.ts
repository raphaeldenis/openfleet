import { mkdtempSync, readFileSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Separates the calls in the argv log; an argument of gh may be `--`, so `--` cannot do it. */
const END_OF_CALL = '<<end-of-call>>';

export interface FakeGhBehaviour {
  stdout?: string;
  exitCode?: number;
  /** Seconds the fake sleeps before answering, to provoke a timeout. */
  sleepSeconds?: number;
}

export interface FakeGh {
  executable: string;
  /** One entry per invocation: the argv gh received. */
  invocations(): string[][];
  /** The environment variable names the fake saw. */
  environmentNames(): string[];
  setBehaviour(behaviour: FakeGhBehaviour): void;
}

/** Writes an executable shell script that stands in for the `gh` binary: it records its argv and environment, then answers as told. */
export function createFakeGh(initial: FakeGhBehaviour = {}): FakeGh {
  const directory = mkdtempSync(join(tmpdir(), 'openfleet-fake-gh-'));
  const executable = join(directory, 'gh');
  const payloadFile = join(directory, 'payload');
  const exitCodeFile = join(directory, 'exit-code');
  const sleepFile = join(directory, 'sleep-seconds');
  const argvLog = join(directory, 'argv.log');
  const environmentLog = join(directory, 'environment.log');

  writeFileSync(executable, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" >> '${argvLog}'`,
    `printf '%s\\n' '${END_OF_CALL}' >> '${argvLog}'`,
    `env | cut -d= -f1 >> '${environmentLog}'`,
    `if [ "$(cat '${sleepFile}')" != "0" ]; then exec sleep "$(cat '${sleepFile}')"; fi`,
    `cat '${payloadFile}'`,
    `exit "$(cat '${exitCodeFile}')"`,
    '',
  ].join('\n'));
  chmodSync(executable, 0o755);

  const setBehaviour = ({ stdout = '', exitCode = 0, sleepSeconds = 0 }: FakeGhBehaviour): void => {
    writeFileSync(payloadFile, stdout);
    writeFileSync(exitCodeFile, String(exitCode));
    writeFileSync(sleepFile, String(sleepSeconds));
  };
  setBehaviour(initial);

  const invocations = (): string[][] => {
    if (!existsSync(argvLog)) return [];
    const calls = readFileSync(argvLog, 'utf8').split(`\n${END_OF_CALL}\n`).filter((call) => call !== '');
    return calls.map((call) => call.replace(`\n${END_OF_CALL}`, '').split('\n'));
  };
  const environmentNames = (): string[] => (existsSync(environmentLog) ? readFileSync(environmentLog, 'utf8').split('\n').filter((name) => name !== '') : []);

  return { executable, invocations, environmentNames, setBehaviour };
}

/** A gh answer for one pull request, with the check shapes gh prints. */
export function ghPullRequestJson({ state = 'OPEN', headRefOid = 'a'.repeat(40), checks = [] }: { state?: string; headRefOid?: string; checks?: unknown[] } = {}): string {
  return JSON.stringify({ state, headRefOid, statusCheckRollup: checks });
}

/** One entry of `gh search prs --json ...`. */
export const searchedPullRequest = ({ number = 7, repo = 'acme/widgets', title = 'Fix the cache', author = 'ada', isDraft = false, url = `https://github.com/${repo}/pull/${number}` }: { number?: number; repo?: string; title?: string; author?: string; isDraft?: boolean; url?: string } = {}) =>
  ({ number, title, repository: { name: repo.split('/')[1], nameWithOwner: repo }, author: { login: author }, isDraft, url });

export const ghSearchResultsJson = (entries: unknown[]): string => JSON.stringify(entries);

/** The answer of `gh pr view --json ...` for the detail tool. */
export function ghPullRequestDetailJson({ title = 'Fix the cache', state = 'OPEN', headRefOid = 'a'.repeat(40), headRefName = 'fix-cache', reviewDecision = '', checks = [] }: { title?: string; state?: string; headRefOid?: string; headRefName?: string; reviewDecision?: string; checks?: unknown[] } = {}): string {
  return JSON.stringify({
    number: 7, title, state, isDraft: false, author: { login: 'ada' }, headRefName, baseRefName: 'main', headRefOid,
    url: 'https://github.com/acme/widgets/pull/7', reviewDecision, statusCheckRollup: checks,
  });
}

export const checkRun =({ name = 'build', status = 'COMPLETED', conclusion = 'SUCCESS' }: { name?: string; status?: string; conclusion?: string } = {}) =>
  ({ __typename: 'CheckRun', name, status, conclusion });

export const statusContext = ({ context = 'ci/legacy', state = 'SUCCESS' }: { context?: string; state?: string } = {}) =>
  ({ __typename: 'StatusContext', context, state });
