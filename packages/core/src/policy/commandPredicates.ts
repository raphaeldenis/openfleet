import type { FlagGroups, PolicyRequest, RulePredicate } from '@openfleet/shared';
import type { SimpleCommand } from './commandAnalyzer.js';
import { argsWithoutRepoOptionsAroundGroup } from './ghPrCreate.js';
import { globMatches } from './pathGlob.js';
import { isPlainReadWithin } from './readOnlyAccess.js';
import { parseSearchArguments } from './searchArguments.js';

/** What a predicate is asked about: one simple command, or a tool call that names files instead. */
export interface PredicateContext {
  command?: SimpleCommand;
  writtenPaths: readonly string[];
  request: PolicyRequest;
}

type Check = (predicate: RulePredicate, context: PredicateContext) => boolean;

const KNOWN_PREDICATE_KEYS: ReadonlySet<string> = new Set([
  'program', 'subcommand', 'flags', 'commandPrefix', 'repoWideSearch', 'writesPathMatching', 'argMatching', 'readsOnlyWithin', 'anyOf', 'allOf', 'not',
]);
const GIT_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const FILE_WRITING_REDIRECTS: ReadonlySet<string> = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);
const FILE_COPYING_PROGRAMS: ReadonlySet<string> = new Set(['cp', 'mv']);
const SEARCH_PROGRAMS: ReadonlySet<string> = new Set(['rg', 'grep']);
const WORKTREE_TEMPLATE = '{worktree}';
const SCRATCH_TEMPLATE = '{scratch}';
const TOOL_RESULTS_TEMPLATE = '{toolResults}';

const asList = (value: string | readonly string[]): readonly string[] => (typeof value === 'string' ? [value] : value);
const isOptionToken = (token: string): boolean => token.startsWith('-') && token.length > 1;
const nonOptionArgs = (args: readonly string[]): string[] => args.filter((arg) => !isOptionToken(arg));

export function subcommandOf(command: SimpleCommand): string | undefined {
  const skipsValuedOptions = command.program === 'git';
  let index = 0;
  while (index < command.args.length) {
    const arg = command.args[index] as string;
    if (!isOptionToken(arg)) return arg;
    index += skipsValuedOptions && GIT_OPTIONS_WITH_VALUE.has(arg) ? 2 : 1;
  }
  return undefined;
}

function flagsOf(args: readonly string[]): { short: Set<string>; long: Set<string> } {
  const short = new Set<string>();
  const long = new Set<string>();
  for (const arg of args) {
    if (arg === '--') break;
    if (arg.startsWith('--')) long.add(arg.slice(2).split('=')[0] as string);
    else if (isOptionToken(arg)) for (const flag of arg.slice(1)) short.add(flag);
  }
  return { short, long };
}

function hasFlagGroups(command: SimpleCommand, groups: FlagGroups): boolean {
  const { short, long } = flagsOf(command.args);
  const isGroupPresent = (aliases: string[]): boolean => aliases.some((alias) => (alias.length === 1 ? short.has(alias) : long.has(alias)));
  const hasAll = groups.all === undefined || groups.all.every(isGroupPresent);
  const hasAny = groups.any === undefined || groups.any.some(isGroupPresent);
  const hasNone = groups.none === undefined || !groups.none.some(isGroupPresent);
  return hasAll && hasAny && hasNone;
}

function startsWithWords(command: SimpleCommand, sequence: string[]): boolean {
  const selectsRepositoryByOption = command.program === 'gh' || command.program === 'glab';
  const args = selectsRepositoryByOption ? argsWithoutRepoOptionsAroundGroup(command.program, command.args) : command.args;
  const words = [command.program, ...args];
  return sequence.length <= words.length && sequence.every((alternatives, index) => alternatives.split('|').includes(words[index] as string));
}

function isRecursiveFlag(arg: string): boolean {
  if (arg === '--recursive') return true;
  const isShortCluster = arg.startsWith('-') && !arg.startsWith('--');
  return isShortCluster && (arg.includes('r') || arg.includes('R'));
}

function isRepoWideSearch(command: SimpleCommand): boolean {
  if (command.fedByPipe || !SEARCH_PROGRAMS.has(command.program)) return false;
  const isGrepWithoutRecursion = command.program === 'grep' && !command.args.some(isRecursiveFlag);
  if (isGrepWithoutRecursion) return false;
  return parseSearchArguments(command.program, command.args).searchedPaths.length === 0;
}

function writtenPathsOf(command: SimpleCommand): string[] {
  const redirected = command.redirects
    .filter((redirect) => FILE_WRITING_REDIRECTS.has(redirect.operator) || (redirect.operator === '>&' && !/^([0-9]+|-)$/.test(redirect.target)))
    .map((redirect) => redirect.target);
  const operands = nonOptionArgs(command.args);
  const lastOperand = operands.slice(-1);
  const byProgram = command.program === 'tee' ? operands
    : FILE_COPYING_PROGRAMS.has(command.program) ? lastOperand
    : command.program === 'dd' ? command.args.filter((arg) => arg.startsWith('of=')).map((arg) => arg.slice(3))
    : [];
  return [...redirected, ...byProgram];
}

function rootsOf(templates: string[], request: PolicyRequest): string[] {
  const resolveTemplate = (template: string): string[] => {
    if (template === WORKTREE_TEMPLATE) return request.worktreeRoot === undefined ? [] : [request.worktreeRoot];
    if (template === SCRATCH_TEMPLATE) return request.scratchRoots;
    if (template === TOOL_RESULTS_TEMPLATE) return request.toolResultsRoot === undefined ? [] : [request.toolResultsRoot];
    return [template];
  };
  return templates.flatMap(resolveTemplate);
}

const CHECKS: readonly Check[] = [
  (predicate) => Object.keys(predicate).every((key) => KNOWN_PREDICATE_KEYS.has(key)),
  ({ program }, { command }) => program === undefined || (command !== undefined && asList(program).includes(command.program)),
  ({ subcommand }, { command }) => subcommand === undefined || (command !== undefined && asList(subcommand).includes(subcommandOf(command) ?? '')),
  ({ flags }, { command }) => flags === undefined || (command !== undefined && hasFlagGroups(command, flags)),
  ({ commandPrefix }, { command }) => commandPrefix === undefined || (command !== undefined && commandPrefix.some((sequence) => startsWithWords(command, sequence))),
  ({ repoWideSearch }, { command }) => repoWideSearch === undefined || (command !== undefined && isRepoWideSearch(command)) === repoWideSearch,
  ({ writesPathMatching }, { command, writtenPaths }) => writesPathMatching === undefined
    || [...writtenPaths, ...(command === undefined ? [] : writtenPathsOf(command))].some((path) => writesPathMatching.some((glob) => globMatches(glob, path))),
  ({ argMatching }, { command }) => argMatching === undefined || (command !== undefined && command.args.some((arg) => argMatching.some((glob) => globMatches(glob, arg)))),
  ({ readsOnlyWithin }, { command, request }) => readsOnlyWithin === undefined
    || (command !== undefined && isPlainReadWithin(command, { cwd: request.cwd, roots: rootsOf(readsOnlyWithin, request) })),
  ({ anyOf }, context) => anyOf === undefined || anyOf.some((child) => matchesPredicate(child, context)),
  ({ allOf }, context) => allOf === undefined || allOf.every((child) => matchesPredicate(child, context)),
  ({ not }, context) => not === undefined || !matchesPredicate(not, context),
];

/** Tells whether every key of the predicate holds in the context. An empty predicate always holds. */
export function matchesPredicate(predicate: RulePredicate, context: PredicateContext): boolean {
  return CHECKS.every((check) => check(predicate, context));
}
