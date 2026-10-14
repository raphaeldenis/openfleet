import { scanShell, substitutionScriptsOf, type OperatorToken, type RedirectOperator, type RedirectToken, type ShellToken, type WordToken } from './shellScanner.js';

export const MAX_COMMAND_CHARS = 64 * 1024;
export const MAX_NESTING_DEPTH = 5;
export const MAX_COMMANDS = 2000;

export type CommandOrigin = 'top' | 'inline_shell' | 'substitution' | 'subshell' | 'eval' | 'heredoc_script';
export type AnalysisStatus = 'complete' | 'partial' | 'limit_exceeded';

export interface CommandRedirect { operator: RedirectOperator; fd?: number; target: string; heredocBody?: string }

export interface SimpleCommand {
  /** Basename of the program, after the transparent wrappers are removed. */
  program: string;
  args: string[];
  assignments: string[];
  wrappers: string[];
  redirects: CommandRedirect[];
  fedByPipe: boolean;
  origin: CommandOrigin;
  depth: number;
}

export interface CommandAnalysis { status: AnalysisStatus; commands: SimpleCommand[] }

interface Placement { origin: CommandOrigin; depth: number }
interface PendingHeredoc { body: string; expandsSubstitutions: boolean }
interface PendingCommand {
  words: WordToken[];
  redirects: CommandRedirect[];
  substitutions: string[];
  heredocs: PendingHeredoc[];
}
interface ScriptState {
  pending: PendingCommand;
  redirectAwaitingTarget: { token: RedirectToken; redirect: CommandRedirect } | undefined;
  subshellDepth: number;
  pipeFeedsNext: boolean;
}
interface WrapperSpec { optionsWithValue: ReadonlySet<string>; takesAssignments: boolean }
interface ShellInvocation { inlineScript?: string; readsStdin: boolean }

const NO_VALUED_OPTIONS: ReadonlySet<string> = new Set();
const TRANSPARENT_WRAPPERS: ReadonlyMap<string, WrapperSpec> = new Map([
  ['env', { optionsWithValue: new Set(['-u', '-C', '--unset', '--chdir']), takesAssignments: true }],
  ['rtk', { optionsWithValue: NO_VALUED_OPTIONS, takesAssignments: false }],
  ['time', { optionsWithValue: new Set(['-f', '-o', '--format', '--output']), takesAssignments: false }],
  ['command', { optionsWithValue: NO_VALUED_OPTIONS, takesAssignments: false }],
  ['nice', { optionsWithValue: new Set(['-n', '--adjustment']), takesAssignments: false }],
  ['nohup', { optionsWithValue: NO_VALUED_OPTIONS, takesAssignments: false }],
  ['exec', { optionsWithValue: new Set(['-a']), takesAssignments: false }],
  ['xargs', { optionsWithValue: new Set(['-n', '-I', '-L', '-P', '-s', '-E', '-d', '-a', '--max-args', '--replace', '--max-procs']), takesAssignments: false }],
]);
const LEADING_KEYWORDS: ReadonlySet<string> = new Set(['if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done', '!', '{', '}']);
const SHELL_PROGRAMS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const SHELL_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
const FIND_EXEC_OPTIONS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const FIND_EXEC_TERMINATORS: ReadonlySet<string> = new Set([';', '+']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const isAssignment = (text: string): boolean => ASSIGNMENT.test(text);
const basenameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

function parseShellInvocation(args: string[]): ShellInvocation {
  let index = 0;
  let hasCommandOption = false;
  let hasStdinOption = false;
  while (index < args.length) {
    const arg = args[index] as string;
    if (arg === '--') {
      index += 1;
      break;
    }
    const isOption = (arg.startsWith('-') || arg.startsWith('+')) && arg.length > 1;
    if (!isOption) break;
    const isLongOption = arg.startsWith('--');
    if (!isLongOption) {
      hasCommandOption = hasCommandOption || arg.includes('c');
      hasStdinOption = hasStdinOption || arg.includes('s');
    }
    index += SHELL_OPTIONS_WITH_VALUE.has(arg) ? 2 : 1;
  }
  if (hasCommandOption) return { inlineScript: args[index], readsStdin: false };
  const hasScriptFile = index < args.length;
  return { readsStdin: hasStdinOption || !hasScriptFile };
}

function dropLeadingKeywords(words: WordToken[]): WordToken[] {
  const firstReal = words.findIndex((word) => word.isQuoted || !LEADING_KEYWORDS.has(word.text));
  return firstReal === -1 ? [] : words.slice(firstReal);
}

function skipWrapper(texts: string[], wrapperIndex: number, spec: WrapperSpec, assignments: string[]): number {
  let index = wrapperIndex + 1;
  if (texts[wrapperIndex] === 'rtk' && texts[index] === 'proxy') index += 1;
  while (index < texts.length) {
    const text = texts[index] as string;
    const isOption = text.startsWith('-') && text.length > 1;
    if (text === '--') return index + 1;
    if (isOption) index += spec.optionsWithValue.has(text) ? 2 : 1;
    else if (spec.takesAssignments && isAssignment(text)) {
      assignments.push(text);
      index += 1;
    } else break;
  }
  return index;
}

function unwrapProgram(texts: string[]): { assignments: string[]; wrappers: string[]; programIndex: number } {
  const assignments: string[] = [];
  const wrappers: string[] = [];
  let index = 0;
  while (index < texts.length) {
    const text = texts[index] as string;
    const wrapper = TRANSPARENT_WRAPPERS.get(basenameOf(text));
    if (isAssignment(text)) {
      assignments.push(text);
      index += 1;
    } else if (wrapper !== undefined) {
      wrappers.push(basenameOf(text));
      index = skipWrapper(texts, index, wrapper, assignments);
    } else break;
  }
  return { assignments, wrappers, programIndex: index };
}

const emptyPending = (): PendingCommand => ({ words: [], redirects: [], substitutions: [], heredocs: [] });

class AnalysisRun {
  readonly commands: SimpleCommand[] = [];
  status: AnalysisStatus = 'complete';
  private isStopped = false;

  analyzeScript(source: string, context: Placement): void {
    const { tokens, isPartial } = scanShell(source);
    if (isPartial) this.markPartial();
    const state: ScriptState = { pending: emptyPending(), redirectAwaitingTarget: undefined, subshellDepth: 0, pipeFeedsNext: false };
    for (const token of tokens) {
      if (this.isStopped) return;
      this.consume(token, state, context);
    }
    this.flush(state, context);
  }

  private markPartial(): void {
    if (this.status === 'complete') this.status = 'partial';
  }

  private markLimitExceeded(): void {
    this.status = 'limit_exceeded';
  }

  private consume(token: ShellToken, state: ScriptState, context: Placement): void {
    if (token.kind === 'word') this.consumeWord(token, state);
    else if (token.kind === 'redirect') this.consumeRedirect(token, state);
    else this.consumeOperator(token, state, context);
  }

  private consumeWord(word: WordToken, state: ScriptState): void {
    state.pending.substitutions.push(...word.substitutions);
    const awaiting = state.redirectAwaitingTarget;
    if (awaiting === undefined) {
      state.pending.words.push(word);
      return;
    }
    awaiting.redirect.target = word.text;
    if (awaiting.token.heredoc !== undefined) {
      awaiting.redirect.heredocBody = awaiting.token.heredoc.body;
      state.pending.heredocs.push(awaiting.token.heredoc);
    }
    state.redirectAwaitingTarget = undefined;
  }

  private consumeRedirect(token: RedirectToken, state: ScriptState): void {
    const redirect: CommandRedirect = token.fd === undefined ? { operator: token.operator, target: '' } : { operator: token.operator, fd: token.fd, target: '' };
    state.pending.redirects.push(redirect);
    state.redirectAwaitingTarget = { token, redirect };
  }

  private consumeOperator({ operator }: OperatorToken, state: ScriptState, context: Placement): void {
    this.flush(state, context);
    if (operator === '(') state.subshellDepth += 1;
    else if (operator === ')') state.subshellDepth = Math.max(0, state.subshellDepth - 1);
    const feedsNextCommand = operator === '|' || operator === '|&';
    const keepsPipePending = operator === '(' || operator === ')';
    if (feedsNextCommand) state.pipeFeedsNext = true;
    else if (!keepsPipePending) state.pipeFeedsNext = false;
  }

  private flush(state: ScriptState, context: Placement): void {
    const { words, redirects, substitutions, heredocs } = state.pending;
    state.pending = emptyPending();
    state.redirectAwaitingTarget = undefined;
    for (const script of substitutions) this.analyzeNested(script, 'substitution', context);
    for (const heredoc of heredocs) this.analyzeHeredocExpansions(heredoc, context);
    const commandWords = dropLeadingKeywords(words);
    if (commandWords.length === 0) return;
    const isInSubshell = state.subshellDepth > 0 && context.origin === 'top';
    const placement: Placement = { origin: isInSubshell ? 'subshell' : context.origin, depth: context.depth };
    this.emitCommand({ texts: commandWords.map((word) => word.text), redirects, fedByPipe: state.pipeFeedsNext, placement });
    state.pipeFeedsNext = false;
  }

  private analyzeHeredocExpansions(heredoc: PendingHeredoc, context: Placement): void {
    if (!heredoc.expandsSubstitutions) return;
    const { scripts, isPartial } = substitutionScriptsOf(heredoc.body);
    if (isPartial) this.markPartial();
    for (const script of scripts) this.analyzeNested(script, 'substitution', context);
  }

  private emitCommand({ texts, redirects, fedByPipe, placement }: { texts: string[]; redirects: CommandRedirect[]; fedByPipe: boolean; placement: Placement }): void {
    const { assignments, wrappers, programIndex } = unwrapProgram(texts);
    const program = basenameOf(texts[programIndex] ?? '');
    if (program === '') return;
    const command: SimpleCommand = { program, args: texts.slice(programIndex + 1), assignments, wrappers, redirects, fedByPipe, origin: placement.origin, depth: placement.depth };
    if (this.commands.length >= MAX_COMMANDS) {
      this.markLimitExceeded();
      this.isStopped = true;
      return;
    }
    this.commands.push(command);
    this.analyzeNestedScripts(command, placement);
    if (program === 'find') this.analyzeFindExec(command, placement);
  }

  private analyzeNestedScripts(command: SimpleCommand, placement: Placement): void {
    if (command.program === 'eval') {
      this.analyzeNested(command.args.join(' '), 'eval', placement);
      return;
    }
    if (!SHELL_PROGRAMS.has(command.program)) return;
    const invocation = parseShellInvocation(command.args);
    if (invocation.inlineScript !== undefined) this.analyzeNested(invocation.inlineScript, 'inline_shell', placement);
    else if (invocation.readsStdin) this.analyzeStdinScript(command, placement);
  }

  private analyzeStdinScript(command: SimpleCommand, placement: Placement): void {
    for (const redirect of command.redirects) {
      const script = redirect.operator === '<<' ? redirect.heredocBody : redirect.operator === '<<<' ? redirect.target : undefined;
      if (script !== undefined) this.analyzeNested(script, 'heredoc_script', placement);
    }
  }

  private analyzeFindExec(command: SimpleCommand, placement: Placement): void {
    let index = 0;
    while (index < command.args.length) {
      if (!FIND_EXEC_OPTIONS.has(command.args[index] as string)) {
        index += 1;
        continue;
      }
      const terminator = command.args.findIndex((arg, position) => position > index && FIND_EXEC_TERMINATORS.has(arg));
      const end = terminator === -1 ? command.args.length : terminator;
      this.emitCommand({ texts: command.args.slice(index + 1, end), redirects: [], fedByPipe: false, placement });
      index = end + 1;
    }
  }

  private analyzeNested(script: string, origin: CommandOrigin, placement: Placement): void {
    const depth = placement.depth + 1;
    if (depth > MAX_NESTING_DEPTH) {
      this.markLimitExceeded();
      return;
    }
    this.analyzeScript(script, { origin, depth });
  }
}

/**
 * Reads shell text into the simple commands it runs, looking through quotes, pipes, groups, substitutions, heredocs,
 * `sh -c`, `eval`, `find -exec` and transparent wrappers. Variables and globs are not expanded.
 * Never throws; a text it cannot fully read is reported as `partial` with everything readable kept.
 */
export function analyzeCommand(text: string): CommandAnalysis {
  if (text.length > MAX_COMMAND_CHARS) return { status: 'limit_exceeded', commands: [] };
  const run = new AnalysisRun();
  run.analyzeScript(text, { origin: 'top', depth: 0 });
  return { status: run.status, commands: run.commands };
}
