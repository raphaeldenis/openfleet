import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { DeclaredCommandSchema, type DetectedRepository, type PolicyRequest } from '@openfleet/shared';
import type { CommandRedirect, SimpleCommand } from './commandAnalyzer.js';

interface Scope {
  /** Real path of the worktree of the session. */
  worktreeRoot: string;
  cwd: string;
  /** Real paths where a command may write its reports. */
  writableRoots: string[];
}

/** A command once its launchers are removed: the words that remain, and the directories its relative paths may start from. */
interface Invocation { words: string[]; bases: string[] }
type Launcher = (invocation: Invocation, scope: Scope) => Invocation | undefined;

const DECLARED_KINDS = ['test', 'lint', 'typecheck'] as const;
const UNSAFE_TEXT = /[$`~\n\r;|&<>(){}\\!]/;
/** A path is judged on what it names, so a glob (`*?[]`) that the shell expands into other paths is unsafe too. */
const UNSAFE_PATH_TEXT = /[$`~\n\r;|&<>(){}\\!*?[\]]/;
const BARE_PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ALLOWED_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set(['CI', 'NODE_ENV', 'FORCE_COLOR', 'NO_COLOR', 'PYTHONDONTWRITEBYTECODE', 'PYTHONUNBUFFERED', 'TZ', 'LANG']);
const PLAIN_ENVIRONMENT_VALUE = /^[A-Za-z0-9_.:-]*$/;
const PYTEST_PACKAGE_SPEC = /^(pytest|coverage|pytest[-_](cov|xdist|asyncio|mock|timeout|randomly))([<>=~!]=?[0-9A-Za-z.*]+)?$/;
const PLAIN_NAME = /^[A-Za-z0-9_.-]+$/;
const NULL_DEVICE = '/dev/null';
const WRITE_REDIRECTS: ReadonlySet<string> = new Set(['>', '>>', '>|', '&>', '&>>']);

const UV_FLAGS: ReadonlySet<string> = new Set(['--frozen', '--locked', '--offline', '--no-sync', '-q', '--quiet', '--all-extras', '--dev', '--no-dev']);
const UV_PATH_OPTIONS: ReadonlySet<string> = new Set(['--directory', '--project']);
const UV_NAME_OPTIONS: ReadonlySet<string> = new Set(['--extra', '--group']);
const DIRECTORY_OPTIONS_OF_PNPM: ReadonlySet<string> = new Set(['-C', '--dir']);
const DIRECTORY_OPTIONS_OF_MAKE: ReadonlySet<string> = new Set(['-C', '--directory']);

const COVERAGE_REPORT_WITHOUT_FILE = /^(term|term-missing|annotate)(:skip-covered)?$/;

/** What an option may take as value: a pattern, a path read inside the worktree, a path written into the writable roots, or a coverage report spec. */
type ValueRule = RegExp | 'worktreePath' | 'writablePath' | 'coverageReport';
/**
 * The options a program may receive in a vouched command. Every option that is not listed is refused, so a plugin,
 * a configuration file, an argument file or an abbreviated long option can never be smuggled in.
 */
interface OptionPolicy {
  /** Options without value; long ones are written in full, no abbreviation. */
  flags: ReadonlySet<string>;
  /** Letters of the short flags that may be grouped (`-qx`). */
  clusterLetters: string;
  /** Options with a value, long (`--tb=short`, `--tb short`) or short (`-n 4`, `-n4`). */
  valued: ReadonlyMap<string, ValueRule>;
  allowsOperands: boolean;
  /** When set, the first operand can only be this word: it keeps a subcommand (`init`, `watch`) from being read as a path filter. */
  onlyFirstOperand?: string;
}

const ANY_TEXT = /^/;
const NUMBER = /^[0-9]+$/;
const JOBS = /^(auto|logical|[0-9]+)$/;
const RULE_CODES = /^[A-Za-z0-9,]+$/;
const OPTION_POLICY_WITHOUT_OPTIONS: OptionPolicy = { flags: new Set(), clusterLetters: '', valued: new Map(), allowsOperands: true };

const OPTION_POLICIES: ReadonlyMap<string, OptionPolicy> = new Map<string, OptionPolicy>([
  ['pytest', {
    flags: new Set(['--quiet', '--verbose', '--exitfirst', '--no-header', '--disable-warnings', '--lf', '--ff', '--nf', '--last-failed', '--failed-first', '--new-first', '--collect-only', '--showlocals', '--strict-markers', '--strict-config', '--cov', '--no-cov', '--cov-branch', '--setup-show', '--cache-clear']),
    clusterLetters: 'qvxsl',
    valued: new Map<string, ValueRule>([
      ['-k', ANY_TEXT], ['-m', ANY_TEXT], ['-n', JOBS], ['-r', /^[a-zA-Z]+$/],
      ['--tb', /^(auto|long|short|line|native|no)$/], ['--maxfail', NUMBER], ['--durations', NUMBER], ['--timeout', NUMBER],
      ['--color', /^(yes|no|auto)$/], ['--capture', /^(fd|sys|no|tee-sys)$/],
      ['--cov', 'worktreePath'], ['--cov-fail-under', NUMBER], ['--cov-report', 'coverageReport'],
      ['--rootdir', 'worktreePath'], ['--ignore', 'worktreePath'], ['--junitxml', 'writablePath'], ['--basetemp', 'writablePath'],
    ]),
    allowsOperands: true,
  }],
  ['ruff', {
    flags: new Set(['--quiet', '--statistics', '--diff', '--no-cache', '--exit-zero', '--no-fix']),
    clusterLetters: 'q',
    valued: new Map<string, ValueRule>([
      ['--select', RULE_CODES], ['--ignore', RULE_CODES], ['--extend-select', RULE_CODES],
      ['--output-format', /^(concise|full|json|grouped|github|pylint)$/],
    ]),
    allowsOperands: true,
  }],
  ['mypy', {
    flags: new Set(['--strict', '--no-incremental', '--pretty', '--show-error-codes', '--no-error-summary', '--ignore-missing-imports']),
    clusterLetters: 'qv',
    valued: new Map<string, ValueRule>([['--python-version', /^[0-9.]+$/]]),
    allowsOperands: true,
  }],
  ['vitest', {
    flags: new Set(['--run', '--coverage', '--passWithNoTests', '--silent', '--no-color']),
    clusterLetters: '',
    valued: new Map<string, ValueRule>([
      ['--reporter', /^(default|dot|verbose)$/], ['--watch', /^false$/], ['--bail', NUMBER], ['--retry', NUMBER],
      ['-t', ANY_TEXT], ['--testNamePattern', ANY_TEXT],
    ]),
    allowsOperands: true,
    onlyFirstOperand: 'run',
  }],
  ['tsc', { flags: new Set(['--noEmit', '--pretty']), clusterLetters: '', valued: new Map(), allowsOperands: false }],
  ['eslint', { flags: new Set(['--quiet', '--no-cache']), clusterLetters: '', valued: new Map(), allowsOperands: true }],
  ['make', { ...OPTION_POLICY_WITHOUT_OPTIONS, allowsOperands: false }],
]);

const asScopedPath = (path: string, base: string): string => (isAbsolute(path) ? path : join(base, path));
const hasParentSegment = (path: string): boolean => path.split('/').includes('..');
const isBelow = (path: string, root: string): boolean => path.startsWith(root.endsWith(sep) ? root : root + sep);
const isInside = (path: string, root: string): boolean => path === root || isBelow(path, root);

/** The real path of a path that may not exist yet: the deepest existing ancestor is resolved, the missing tail is appended. */
function resolvedPath(path: string): string {
  const absolute = resolve(path);
  const missingTail: string[] = [];
  let existing = absolute;
  for (;;) {
    try {
      return join(realpathSync.native(existing), ...missingTail.reverse());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      missingTail.push(basename(existing));
      existing = parent;
    }
  }
}

function resolvedWhere(path: string, roots: readonly string[], bases: readonly string[], isAccepted: (resolved: string, root: string) => boolean): boolean {
  if (UNSAFE_PATH_TEXT.test(path) || hasParentSegment(path)) return false;
  const startingPoints = isAbsolute(path) ? [''] : bases;
  return startingPoints.every((base) => roots.some((root) => isAccepted(resolvedPath(asScopedPath(path, base)), root)));
}

function resolvedInside(path: string, roots: readonly string[], bases: readonly string[]): boolean {
  return resolvedWhere(path, roots, bases, isInside);
}

/** A written path must be a strict descendant of its root: pytest removes the whole root it is given as base temp directory. */
function resolvedBelow(path: string, roots: readonly string[], bases: readonly string[]): boolean {
  return resolvedWhere(path, roots, bases, isBelow);
}

function splitOption(arg: string): { name: string; inlineValue: string | undefined } {
  const separator = arg.startsWith('--') ? arg.indexOf('=') : -1;
  return separator === -1 ? { name: arg, inlineValue: undefined } : { name: arg.slice(0, separator), inlineValue: arg.slice(separator + 1) };
}

function stripUv({ words, bases }: Invocation, scope: Scope): Invocation | undefined {
  if (words[1] !== 'run') return undefined;
  const directories = [...bases];
  let index = 2;
  while (index < words.length && (words[index] as string).startsWith('-')) {
    const { name, inlineValue } = splitOption(words[index] as string);
    if (UV_FLAGS.has(name) && inlineValue === undefined) {
      index += 1;
      continue;
    }
    const value = inlineValue ?? words[index + 1];
    const isAccepted = value !== undefined && uvValueIsAccepted({ name, value }, scope, bases);
    if (!isAccepted) return undefined;
    if (UV_PATH_OPTIONS.has(name)) directories.push(resolvedPath(asScopedPath(value, bases[0] as string)));
    index += inlineValue === undefined ? 2 : 1;
  }
  return { words: words.slice(index), bases: directories };
}

function uvValueIsAccepted({ name, value }: { name: string; value: string }, scope: Scope, bases: readonly string[]): boolean {
  if (UV_PATH_OPTIONS.has(name)) return resolvedInside(value, [scope.worktreeRoot], bases);
  if (UV_NAME_OPTIONS.has(name)) return PLAIN_NAME.test(value);
  return name === '--with' && PYTEST_PACKAGE_SPEC.test(value);
}

function stripDirectoryOptions({ words, bases }: Invocation, scope: Scope, directoryOptions: ReadonlySet<string>): Invocation | undefined {
  const directories = [...bases];
  let index = 1;
  while (index < words.length && (words[index] as string).startsWith('-')) {
    const { name, inlineValue } = splitOption(words[index] as string);
    const value = inlineValue ?? words[index + 1];
    const isAccepted = directoryOptions.has(name) && value !== undefined && resolvedInside(value, [scope.worktreeRoot], bases);
    if (!isAccepted) return undefined;
    directories.push(resolvedPath(asScopedPath(value, bases[0] as string)));
    index += inlineValue === undefined ? 2 : 1;
  }
  return { words: [words[0] as string, ...words.slice(index)], bases: directories };
}

function stripPnpm(invocation: Invocation, scope: Scope): Invocation | undefined {
  const stripped = stripDirectoryOptions(invocation, scope, DIRECTORY_OPTIONS_OF_PNPM);
  if (stripped === undefined) return undefined;
  const [, subcommand, ...afterSubcommand] = stripped.words;
  const runsABinary = subcommand === 'exec';
  return runsABinary ? { words: afterSubcommand, bases: stripped.bases } : stripped;
}

const LAUNCHERS: ReadonlyMap<string, Launcher> = new Map([
  ['uv', stripUv],
  ['pnpm', stripPnpm],
  ['make', (invocation: Invocation, scope: Scope) => stripDirectoryOptions(invocation, scope, DIRECTORY_OPTIONS_OF_MAKE)],
]);
const MAX_LAUNCHER_DEPTH = 3;

function withoutLaunchers(first: Invocation, scope: Scope): Invocation | undefined {
  let current = first;
  for (let depth = 0; depth < MAX_LAUNCHER_DEPTH; depth += 1) {
    const launcher = LAUNCHERS.get(current.words[0] ?? '');
    if (launcher === undefined) return current;
    const next = launcher(current, scope);
    if (next === undefined) return undefined;
    const isStillTheSameProgram = next.words[0] === current.words[0];
    current = next;
    if (isStillTheSameProgram) return current;
  }
  return current;
}

function coverageReportTargetIsWritable(value: string, scope: Scope, bases: readonly string[]): boolean {
  if (COVERAGE_REPORT_WITHOUT_FILE.test(value)) return true;
  const target = value.slice(value.indexOf(':') + 1);
  const hasTarget = value.includes(':') && target !== '';
  return hasTarget && resolvedBelow(target, scope.writableRoots, bases);
}

interface ArgumentContext { policy: OptionPolicy; scope: Scope; bases: readonly string[] }

function valueIsAccepted(rule: ValueRule, value: string, { scope, bases }: ArgumentContext): boolean {
  if (rule instanceof RegExp) return rule.test(value);
  if (rule === 'worktreePath') return resolvedInside(value, [scope.worktreeRoot], bases);
  if (rule === 'writablePath') return resolvedBelow(value, scope.writableRoots, bases);
  return coverageReportTargetIsWritable(value, scope, bases);
}

/** Returns how many arguments a long option takes (itself and its value), or undefined when the option is not allowed. */
function widthOfLongOption(args: readonly string[], index: number, context: ArgumentContext): number | undefined {
  const { name, inlineValue } = splitOption(args[index] as string);
  const isFlag = inlineValue === undefined && context.policy.flags.has(name);
  if (isFlag) return 1;
  const rule = context.policy.valued.get(name);
  const value = inlineValue ?? args[index + 1];
  if (rule === undefined || value === undefined || !valueIsAccepted(rule, value, context)) return undefined;
  return inlineValue === undefined ? 2 : 1;
}

/** Returns how many arguments a short option or cluster takes, or undefined when it is not allowed. */
function widthOfShortOption(args: readonly string[], index: number, context: ArgumentContext): number | undefined {
  const arg = args[index] as string;
  const rule = context.policy.valued.get(arg.slice(0, 2));
  const attachedValue = arg.slice(2);
  if (rule !== undefined) {
    const value = attachedValue === '' ? args[index + 1] : attachedValue;
    if (value === undefined || !valueIsAccepted(rule, value, context)) return undefined;
    return attachedValue === '' ? 2 : 1;
  }
  const letters = [...arg.slice(1)];
  const isClusterOfAllowedFlags = letters.length > 0 && letters.every((letter) => context.policy.clusterLetters.includes(letter));
  return isClusterOfAllowedFlags ? 1 : undefined;
}

/**
 * Tells whether the arguments of a declared command only use the options the program allows, read inside the worktree
 * and write into the writable roots. An argument file (`@file`) is never accepted.
 */
function argumentsStaySafe(args: readonly string[], context: ArgumentContext): boolean {
  const { policy, scope, bases } = context;
  const hasArgumentFile = args.some((arg) => arg.startsWith('@'));
  if (hasArgumentFile || args.some((arg) => UNSAFE_TEXT.test(arg))) return false;
  let index = 0;
  let operandCount = 0;
  while (index < args.length) {
    const arg = args[index] as string;
    const isOperand = !arg.startsWith('-');
    if (isOperand) {
      const path = arg.split('::')[0] as string;
      const isFirstOperand = operandCount === 0;
      const isForbiddenSubcommand = isFirstOperand && policy.onlyFirstOperand !== undefined && arg !== policy.onlyFirstOperand;
      if (!policy.allowsOperands || isForbiddenSubcommand || !resolvedInside(path, [scope.worktreeRoot], bases)) return false;
      operandCount += 1;
      index += 1;
      continue;
    }
    const width = arg.startsWith('--') ? widthOfLongOption(args, index, context) : widthOfShortOption(args, index, context);
    if (width === undefined) return false;
    index += width;
  }
  return true;
}

function redirectIsHarmless(redirect: CommandRedirect, scope: Scope): boolean {
  const { operator, target } = redirect;
  const isDescriptorDuplication = (operator === '>&' || operator === '<&') && (target === '-' || /^[0-9]+$/.test(target));
  if (isDescriptorDuplication) return true;
  if (operator === '<') return resolvedInside(target, [scope.worktreeRoot], [scope.cwd]);
  if (!WRITE_REDIRECTS.has(operator)) return false;
  return target === NULL_DEVICE || resolvedBelow(target, scope.writableRoots, [scope.cwd]);
}

function isAllowedAssignment(assignment: string): boolean {
  const separator = assignment.indexOf('=');
  return ALLOWED_ENVIRONMENT_NAMES.has(assignment.slice(0, separator)) && PLAIN_ENVIRONMENT_VALUE.test(assignment.slice(separator + 1));
}

function hasPlainLaunch(command: SimpleCommand): boolean {
  const onlyEnvWrapper = command.wrappers.every((wrapper) => wrapper === 'env') && command.wrapperOptions.length === 0;
  return onlyEnvWrapper && command.assignments.every(isAllowedAssignment);
}

function isChangeToWorktree(command: SimpleCommand, scope: Scope): boolean {
  const [target, ...surplus] = command.args;
  if (target === undefined || surplus.length > 0 || target.startsWith('-')) return false;
  if (UNSAFE_PATH_TEXT.test(target) || hasParentSegment(target)) return false;
  const reached = resolvedPath(asScopedPath(target, scope.cwd));
  return reached === scope.worktreeRoot || reached === resolvedPath(scope.cwd);
}

const PROGRAMS_WITH_A_SUBCOMMAND: ReadonlySet<string> = new Set(['pnpm', 'npm', 'yarn', 'cargo', 'go', 'make']);
const SCRIPT_RUNNERS: ReadonlySet<string> = new Set(['pnpm', 'npm', 'yarn']);

/** The words that name what runs (`pnpm run lint`, `cargo test`, `pytest`); every word after them is an argument. */
function wordsNamingTheCommand(declaredWords: readonly string[]): number {
  const [program, subcommand] = declaredWords;
  const runsAScript = SCRIPT_RUNNERS.has(program as string) && subcommand === 'run';
  if (runsAScript) return 3;
  return PROGRAMS_WITH_A_SUBCOMMAND.has(program as string) ? 2 : 1;
}

function matchesDeclaredForm(invocation: Invocation, declared: string, scope: Scope): boolean {
  const declaredWords = declared.split(' ').filter((word) => word !== '');
  const startsWithDeclaredWords = declaredWords.length > 0 && declaredWords.every((word, index) => invocation.words[index] === word);
  const policy = OPTION_POLICIES.get(declaredWords[0] as string) ?? OPTION_POLICY_WITHOUT_OPTIONS;
  const argumentsOfInvocation = invocation.words.slice(wordsNamingTheCommand(declaredWords));
  return startsWithDeclaredWords && argumentsStaySafe(argumentsOfInvocation, { policy, scope, bases: invocation.bases });
}

function scopeOf(request: PolicyRequest): Scope | undefined {
  if (request.worktreeRoot === undefined) return undefined;
  const worktreeRoot = resolvedPath(request.worktreeRoot);
  const cwd = resolvedPath(request.cwd);
  if (!isInside(cwd, worktreeRoot)) return undefined;
  const scratchRoots = [`${request.worktreeRoot}/.scratch`, ...request.scratchRoots];
  return { worktreeRoot, cwd, writableRoots: scratchRoots.map(resolvedPath) };
}

/**
 * Tells whether one simple command is a declared command in a canonical form, or a `cd` to the worktree.
 * The launchers `env KEY=value`, `uv run`, `pnpm -C dir [exec]` and `make -C dir` are removed first; every directory they
 * name, every path argument and every redirect must stay inside the worktree, and reports may only go to `.scratch`.
 * Anything the function does not recognise is not vouched for.
 */
export function runsDeclaredCommand(command: SimpleCommand, declared: readonly string[], request: PolicyRequest): boolean {
  const scope = scopeOf(request);
  const isPlainTopLevelCommand = command.origin === 'top' && !command.fedByPipe && !command.textHasBareAssignment && hasPlainLaunch(command);
  const hasCarriageReturn = request.command?.includes('\r') ?? false;
  if (scope === undefined || declared.length === 0 || !isPlainTopLevelCommand || hasCarriageReturn) return false;
  if (!command.redirects.every((redirect) => redirectIsHarmless(redirect, scope))) return false;
  if (command.program === 'cd') return command.wrappers.length === 0 && isChangeToWorktree(command, scope);
  const launched = withoutLaunchers({ words: [command.invokedAs, ...command.args], bases: [scope.cwd, scope.worktreeRoot] }, scope);
  const isBareProgram = launched !== undefined && BARE_PROGRAM.test(launched.words[0] ?? '');
  return isBareProgram && declared.some((form) => matchesDeclaredForm(launched, form, scope));
}

/** Names the commands to declare for a detected repository: its test, lint and typecheck commands, in that order. */
export function declaredCommandsFrom(commands: DetectedRepository['commands']): string[] {
  const detected = DECLARED_KINDS.flatMap((kind) => commands[kind]?.command ?? []);
  return detected.filter((command) => DeclaredCommandSchema.safeParse(command).success);
}
