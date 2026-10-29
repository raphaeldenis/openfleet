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

/** The arguments of a gh or glab command with the repository options that sit before the subcommand removed: they select a repository, not a command. */
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

const GROUPS_THAT_TAKE_REPO_OPTIONS_BEFORE_THE_ACTION: Readonly<Record<string, string>> = { gh: 'pr', glab: 'mr' };

/** Like `argsWithoutLeadingRepoOptions`, and also removes the repository options between the `pr` (gh) or `mr` (glab) group and its action. */
export function argsWithoutRepoOptionsAroundGroup(program: string, args: readonly string[]): string[] {
  const argsFromGroup = argsWithoutLeadingRepoOptions(args);
  const [group, ...afterGroup] = argsFromGroup;
  const isGroupWithAction = group !== undefined && group === GROUPS_THAT_TAKE_REPO_OPTIONS_BEFORE_THE_ACTION[program];
  if (!isGroupWithAction) return argsFromGroup;
  return [group, ...argsWithoutLeadingRepoOptions(afterGroup)];
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

const creationWithHead = (headValue: string | undefined): PullRequestCreation => {
  const headBranch = headValue === undefined ? '' : branchOf(headValue);
  return headBranch === '' ? {} : { headBranch };
};

const GLAB_SOURCE_BRANCH_OPTIONS: ReadonlySet<string> = new Set(['--source-branch', '-s']);
const GLAB_SOURCE_BRANCH_ASSIGNMENT_PREFIX = '--source-branch=';

function glabSourceBranchOf(args: readonly string[]): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (GLAB_SOURCE_BRANCH_OPTIONS.has(arg)) return args[index + 1];
    if (arg.startsWith(GLAB_SOURCE_BRANCH_ASSIGNMENT_PREFIX)) return arg.slice(GLAB_SOURCE_BRANCH_ASSIGNMENT_PREFIX.length);
  }
  return undefined;
}

const API_METHOD_OPTIONS: ReadonlySet<string> = new Set(['-X', '--method']);
const API_METHOD_ASSIGNMENT_PREFIX = '--method=';
const API_FIELD_OPTIONS: ReadonlySet<string> = new Set(['-f', '-F', '--field', '--raw-field']);
const API_FIELD_ASSIGNMENT_PREFIXES = ['--field=', '--raw-field='];
const API_OPTIONS_WITH_OTHER_VALUE: ReadonlySet<string> = new Set(['-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '--cache']);
const PULLS_ENDPOINT = /(^|\/)pulls\/?$/;
const HEAD_FIELD_PREFIX = 'head=';

interface ApiRequest { endpoint: string | undefined; method: string | undefined; fields: string[]; hasInput: boolean }

/** Reads what a `gh api` command asks for: its endpoint, an explicit method, the `-f`/`-F` fields and whether the body comes from `--input`. */
function apiRequestOf(args: readonly string[]): ApiRequest {
  const request: ApiRequest = { endpoint: undefined, method: undefined, fields: [], hasInput: false };
  let index = 0;
  while (index < args.length) {
    const arg = args[index] as string;
    const next = args[index + 1];
    index += 1;
    if (API_METHOD_OPTIONS.has(arg)) { request.method = next; index += 1; continue; }
    if (arg.startsWith(API_METHOD_ASSIGNMENT_PREFIX)) { request.method = arg.slice(API_METHOD_ASSIGNMENT_PREFIX.length); continue; }
    if (arg.startsWith('-X') && !arg.startsWith('--')) { request.method = arg.slice(2); continue; }
    if (API_FIELD_OPTIONS.has(arg)) { if (next !== undefined) request.fields.push(next); index += 1; continue; }
    const fieldPrefix = API_FIELD_ASSIGNMENT_PREFIXES.find((prefix) => arg.startsWith(prefix));
    if (fieldPrefix !== undefined) { request.fields.push(arg.slice(fieldPrefix.length)); continue; }
    const isAttachedShortField = /^-[fF]./.test(arg);
    if (isAttachedShortField) { request.fields.push(arg.slice(2)); continue; }
    if (arg === '--input') { request.hasInput = true; index += 1; continue; }
    if (API_OPTIONS_WITH_OTHER_VALUE.has(arg)) { index += 1; continue; }
    const isPositional = !arg.startsWith('-');
    if (isPositional && request.endpoint === undefined) request.endpoint = arg;
  }
  return request;
}

/** A `gh api` call creates a pull request when it POSTs to a `/pulls` endpoint; gh posts by itself as soon as the call carries fields or an input. */
function apiCreationOf(args: readonly string[]): PullRequestCreation | undefined {
  const { endpoint, method, fields, hasInput } = apiRequestOf(args);
  const endpointPath = endpoint?.split(/[?#]/)[0];
  const targetsPulls = endpointPath !== undefined && PULLS_ENDPOINT.test(endpointPath);
  const carriesBody = fields.length > 0 || hasInput;
  const effectiveMethod = (method ?? (carriesBody ? 'POST' : 'GET')).toUpperCase();
  if (!targetsPulls || effectiveMethod !== 'POST') return undefined;
  const headField = fields.find((field) => field.startsWith(HEAD_FIELD_PREFIX));
  return creationWithHead(headField?.slice(HEAD_FIELD_PREFIX.length));
}

function creationOf(command: SimpleCommand): PullRequestCreation | undefined {
  if (command.program === 'glab') {
    const [group, action, ...options] = argsWithoutRepoOptionsAroundGroup(command.program, command.args);
    const isMergeRequestCreation = group === 'mr' && (action === 'create' || action === 'new');
    return isMergeRequestCreation ? creationWithHead(glabSourceBranchOf(options)) : undefined;
  }
  if (command.program !== 'gh') return undefined;
  const [group, action, ...options] = argsWithoutRepoOptionsAroundGroup(command.program, command.args);
  if (group === 'api') return apiCreationOf([action, ...options].filter((arg): arg is string => arg !== undefined));
  const isPullRequestCreation = group === 'pr' && action === 'create';
  if (!isPullRequestCreation) return undefined;
  return creationWithHead(headValueOf(options));
}

/** Every pull or merge request creation the shell text runs (`gh pr create`, a POST of `gh api` to /pulls, `glab mr create`), in order, with the head branch each one names. */
export function pullRequestCreationsOf(commandText: string): PullRequestCreation[] {
  return analyzeCommand(commandText).commands.flatMap((command) => creationOf(command) ?? []);
}
