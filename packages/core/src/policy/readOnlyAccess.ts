import type { CommandRedirect, SimpleCommand } from './commandAnalyzer.js';
import { isReadOnlySedScript } from './sedScript.js';
import { parseSearchArguments } from './searchArguments.js';

export interface ReadScope {
  /** Absolute directory the command runs in; relative operands resolve against it. */
  cwd: string;
  /** Absolute directories the command may read from. */
  roots: readonly string[];
}

const READ_ONLY_PROGRAMS: ReadonlySet<string> = new Set(['sed', 'grep', 'rg', 'cat', 'head', 'tail', 'wc', 'ls', 'sort', 'uniq', 'cut', 'tr', 'awk', 'find']);
const COMMAND_ORIGINS_WITHOUT_EXECUTION: ReadonlySet<string> = new Set(['top', 'subshell']);
const WRITE_REDIRECTS: ReadonlySet<string> = new Set(['>', '>>', '>|', '&>', '&>>']);
const NULL_DEVICE = '/dev/null';
const SED_FLAGS_WITH_VALUE = new Set(['l']);
const SED_LONG_OPTIONS: ReadonlySet<string> = new Set(['--quiet', '--silent', '--regexp-extended', '--null-data', '--separate', '--unbuffered', '--posix', '--debug']);
const FIND_WRITING_OR_RUNNING_PREFIXES = ['-delete', '-exec', '-ok', '-fprint', '-fls'] as const;
const AWK_FORBIDDEN_SCRIPT_TEXT = /system|getline|[>|]/;
const NON_PATH_MARKERS = /[$`]/;

const isOption = (arg: string): boolean => arg.startsWith('-') && arg.length > 1;
const positionalsOf = (args: string[]): string[] => args.filter((arg) => !isOption(arg));

function normalizedSegments(path: string): string[] {
  const resolved: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '..') resolved.pop();
    else if (segment !== '' && segment !== '.') resolved.push(segment);
  }
  return resolved;
}

function isInsideRoot(path: string[], root: string[]): boolean {
  return root.length > 0 && root.length <= path.length && root.every((segment, index) => path[index] === segment);
}

/** Tells whether a path operand resolves, against the cwd of the scope, to a place inside one of its roots. */
export function isReadableUnderRoots(operand: string, scope: ReadScope): boolean {
  if (operand === '-') return true;
  const isResolvable = !NON_PATH_MARKERS.test(operand) && !operand.startsWith('~');
  if (!isResolvable) return false;
  const absolute = operand.startsWith('/') ? operand : `${scope.cwd}/${operand}`;
  const segments = normalizedSegments(absolute);
  return scope.roots.some((root) => isInsideRoot(segments, normalizedSegments(root)));
}

function redirectIsHarmless(redirect: CommandRedirect, scope: ReadScope): boolean {
  const { operator, target } = redirect;
  const isDescriptorDuplication = (operator === '>&' || operator === '<&') && (target === '-' || /^[0-9]+$/.test(target));
  if (isDescriptorDuplication) return true;
  if (operator === '<') return isReadableUnderRoots(target, scope);
  return WRITE_REDIRECTS.has(operator) && target === NULL_DEVICE;
}

function sedIsReadOnly(args: string[]): { isReadOnly: boolean; files: string[] } {
  const scripts: string[] = [];
  const positionals: string[] = [];
  let index = 0;
  while (index < args.length) {
    const arg = args[index] as string;
    index += 1;
    if (arg.startsWith('--expression=')) scripts.push(arg.slice('--expression='.length));
    else if (arg === '--expression') scripts.push(args[index++] ?? '');
    else if (arg.startsWith('--')) {
      if (!SED_LONG_OPTIONS.has(arg)) return { isReadOnly: false, files: [] };
    } else if (isOption(arg)) {
      const cluster = arg.slice(1);
      const refused = [...cluster].some((flag) => flag === 'i' || flag === 'f');
      if (refused) return { isReadOnly: false, files: [] };
      const expressionAt = cluster.indexOf('e');
      if (expressionAt !== -1) {
        const inline = cluster.slice(expressionAt + 1);
        scripts.push(inline !== '' ? inline : (args[index++] ?? ''));
      } else if ([...cluster].some((flag) => SED_FLAGS_WITH_VALUE.has(flag))) index += 1;
    } else positionals.push(arg);
  }
  const hasExpressionOption = scripts.length > 0;
  const allScripts = hasExpressionOption ? scripts : positionals.slice(0, 1);
  const files = hasExpressionOption ? positionals : positionals.slice(1);
  return { isReadOnly: allScripts.length > 0 && allScripts.every(isReadOnlySedScript), files };
}

function awkIsReadOnly(args: string[]): { isReadOnly: boolean; files: string[] } {
  const positionals: string[] = [];
  let index = 0;
  while (index < args.length) {
    const arg = args[index] as string;
    index += 1;
    if (arg === '-F' || arg === '-v') index += 1;
    else if (arg.startsWith('-F') || (arg.startsWith('-v') && arg.length > 2)) continue;
    else if (isOption(arg)) return { isReadOnly: false, files: [] };
    else positionals.push(arg);
  }
  const [script, ...files] = positionals;
  const isReadOnly = script !== undefined && !AWK_FORBIDDEN_SCRIPT_TEXT.test(script);
  return { isReadOnly, files };
}

function searchIsReadOnly(program: string, args: string[]): { isReadOnly: boolean; files: string[] } {
  const runsAPreprocessor = program === 'rg' && args.some((arg) => arg.startsWith('--pre') || arg.startsWith('--hostname-bin'));
  const { searchedPaths, patternFiles } = parseSearchArguments(program, args);
  return { isReadOnly: !runsAPreprocessor, files: [...searchedPaths, ...patternFiles] };
}

function sortIsReadOnly(args: string[]): { isReadOnly: boolean; files: string[] } {
  const writesOrRuns = args.some((arg) => arg.startsWith('--output') || arg.startsWith('--compress-program') || (isOption(arg) && !arg.startsWith('--') && /[oT]/.test(arg)));
  return { isReadOnly: !writesOrRuns, files: positionalsOf(args) };
}

function uniqIsReadOnly(args: string[]): { isReadOnly: boolean; files: string[] } {
  const files = positionalsOf(args);
  return { isReadOnly: files.length <= 1, files };
}

function findIsReadOnly(args: string[]): { isReadOnly: boolean; files: string[] } {
  const writesOrRuns = args.some((arg) => FIND_WRITING_OR_RUNNING_PREFIXES.some((prefix) => arg.startsWith(prefix)));
  const firstExpression = args.findIndex((arg) => arg.startsWith('-') || arg === '!' || arg === '(');
  const startPaths = args.slice(0, firstExpression === -1 ? args.length : firstExpression);
  return { isReadOnly: !writesOrRuns, files: startPaths.length > 0 ? startPaths : ['.'] };
}

function inspectArguments(command: SimpleCommand): { isReadOnly: boolean; files: string[] } {
  const { program, args } = command;
  if (program === 'sed') return sedIsReadOnly(args);
  if (program === 'awk') return awkIsReadOnly(args);
  if (program === 'grep' || program === 'rg') return searchIsReadOnly(program, args);
  if (program === 'sort') return sortIsReadOnly(args);
  if (program === 'uniq') return uniqIsReadOnly(args);
  if (program === 'find') return findIsReadOnly(args);
  return { isReadOnly: true, files: positionalsOf(args) };
}

/**
 * Tells whether a simple command only reads: a program from a closed list, run without wrapper, assignment or
 * substitution, with no write redirection and no flag or script that writes or executes, and every path it names
 * inside the given roots.
 */
export function isPlainReadWithin(command: SimpleCommand, scope: ReadScope): boolean {
  const isPlainInvocation = READ_ONLY_PROGRAMS.has(command.program)
    && command.wrappers.length === 0
    && command.assignments.length === 0
    && COMMAND_ORIGINS_WITHOUT_EXECUTION.has(command.origin);
  if (!isPlainInvocation) return false;
  if (!command.redirects.every((redirect) => redirectIsHarmless(redirect, scope))) return false;
  const { isReadOnly, files } = inspectArguments(command);
  return isReadOnly && files.every((file) => isReadableUnderRoots(file, scope));
}
