import { analyzeCommand, type SimpleCommand } from './commandAnalyzer.js';

const REPO_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set(['-R', '--repo']);
const HEAD_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set(['--head', '-H']);
const HEAD_ASSIGNMENT_PREFIX = '--head=';
const SHORT_HEAD_PREFIX = '-H';
const OWNER_SEPARATOR = ':';

export interface PullRequestCreation {
  /** The branch named by `--head` / `-H`, without its `owner:`; absent when the command names none. */
  headBranch?: string;
}

/** The arguments of a gh command with the repository options that sit before the subcommand removed: they select a repository, not a command. */
export function argsWithoutLeadingRepoOptions(args: readonly string[]): string[] {
  let index = 0;
  while (index < args.length) {
    const arg = args[index] as string;
    if (REPO_OPTIONS_WITH_VALUE.has(arg)) index += 2;
    else if (arg.startsWith('--repo=') || (arg.startsWith('-R') && arg.length > 2)) index += 1;
    else break;
  }
  return args.slice(index);
}

function headValueOf(args: readonly string[]): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (HEAD_OPTIONS_WITH_VALUE.has(arg)) return args[index + 1];
    if (arg.startsWith(HEAD_ASSIGNMENT_PREFIX)) return arg.slice(HEAD_ASSIGNMENT_PREFIX.length);
    if (arg.startsWith(SHORT_HEAD_PREFIX) && arg.length > SHORT_HEAD_PREFIX.length && !arg.startsWith('--')) return arg.slice(SHORT_HEAD_PREFIX.length);
  }
  return undefined;
}

const branchOf = (headValue: string): string => headValue.slice(headValue.lastIndexOf(OWNER_SEPARATOR) + 1);

function creationOf(command: SimpleCommand): PullRequestCreation | undefined {
  if (command.program !== 'gh') return undefined;
  const [group, action, ...options] = argsWithoutLeadingRepoOptions(command.args);
  const isPullRequestCreation = group === 'pr' && action === 'create';
  if (!isPullRequestCreation) return undefined;
  const headValue = headValueOf(options);
  const headBranch = headValue === undefined ? '' : branchOf(headValue);
  return headBranch === '' ? {} : { headBranch };
}

/** Every `gh pr create` the shell text runs, in order, with the head branch each one names. */
export function pullRequestCreationsOf(commandText: string): PullRequestCreation[] {
  return analyzeCommand(commandText).commands.flatMap((command) => creationOf(command) ?? []);
}
