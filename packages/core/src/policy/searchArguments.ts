const OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  '-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '-A', '-B', '-C', '-m', '--max-count', '--max-depth',
  '-d', '-j', '--threads', '--encoding', '--include', '--exclude', '--exclude-dir', '--include-dir',
]);
const RIPGREP_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set(['-E', '-r', '--replace']);
const PATTERN_OPTIONS: ReadonlySet<string> = new Set(['-e', '--regexp']);
const PATTERN_FILE_OPTIONS: ReadonlySet<string> = new Set(['-f', '--file']);

export interface SearchArguments {
  /** The search pattern comes from `-e` or `-f` instead of the first positional argument. */
  isPatternGivenByOption: boolean;
  /** Files and directories searched, in order. Empty when the search reads the working directory or stdin. */
  searchedPaths: string[];
  /** Files named by `-f`/`--file`, read for their patterns. */
  patternFiles: string[];
}

/** Splits the arguments of `grep`/`rg` into the pattern source, the searched paths and the pattern files. */
export function parseSearchArguments(program: string, args: string[]): SearchArguments {
  const valuedOptions = program === 'rg' ? new Set([...OPTIONS_WITH_VALUE, ...RIPGREP_OPTIONS_WITH_VALUE]) : OPTIONS_WITH_VALUE;
  const positionals: string[] = [];
  const patternFiles: string[] = [];
  let isPatternGivenByOption = false;
  let index = 0;
  while (index < args.length) {
    const arg = args[index] as string;
    const next = args[index + 1];
    if (PATTERN_OPTIONS.has(arg)) {
      isPatternGivenByOption = true;
      index += 2;
    } else if (PATTERN_FILE_OPTIONS.has(arg)) {
      isPatternGivenByOption = true;
      if (next !== undefined) patternFiles.push(next);
      index += 2;
    } else if (valuedOptions.has(arg)) {
      index += 2;
    } else if (arg.startsWith('-') && arg !== '-') {
      index += 1;
    } else {
      positionals.push(arg);
      index += 1;
    }
  }
  return { isPatternGivenByOption, searchedPaths: isPatternGivenByOption ? positionals : positionals.slice(1), patternFiles };
}
