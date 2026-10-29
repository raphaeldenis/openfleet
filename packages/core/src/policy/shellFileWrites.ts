import type { CommandRedirect, SimpleCommand } from './commandAnalyzer.js';
import { isReadableUnderRoots, type ReadScope } from './readOnlyAccess.js';

const FILE_WRITING_REDIRECTS: ReadonlySet<string> = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);
const DESCRIPTOR_TARGET = /^([0-9]+|-)$/;
const HARMLESS_DEVICES: ReadonlySet<string> = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);
const DESCRIPTOR_DEVICE_PREFIX = '/dev/fd/';

const INTERPRETER_PROGRAM = /^(python[0-9.]*|node(?:js)?|deno|bun|ruby|perl|php)$/;
const INLINE_CODE_OPTION = /^-[a-zA-Z]*[ceEp]/;
const INLINE_CODE_LONG_OPTIONS = ['--eval', '--print', '--command'] as const;
const INLINE_CODE_SUBCOMMANDS: ReadonlySet<string> = new Set(['eval']);
const PERL_IN_PLACE_OPTION = /^-(?![MmI])[a-zA-Z0-9]*i/;
const SED_SCRIPT_OPTIONS: ReadonlySet<string> = new Set(['-e', '-f', '--expression', '--file']);

const OPEN_FOR_WRITING = /\bopen\s*\(\s*(?:[^,()]|\([^()]*\))+,\s*(?:mode\s*=\s*)?['"][rwxabt+]*[wax+][rwxabt+]*['"]/;
const OPEN_WITH_MODE_KEYWORD = /\bopen\s*\([^)]*\bmode\s*=\s*['"][rwxabt+]*[wax+][rwxabt+]*['"]/;
const PATH_OPEN_FOR_WRITING = /\.open\s*\(\s*(?:mode\s*=\s*)?['"][rwxabt+]*[wax+][rwxabt+]*['"]/;
const ALIASED_OPEN_FOR_WRITING = /\(\s*[^()]*,\s*['"](?:w|wb|wt|x|xb|ab|a\+|w\+|r\+)['"]\s*[,)]/;
const WRITE_CALLS = /\b(?:write_text|write_bytes|writeFile|writeFileSync|writeTextFile|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|file_put_contents|binwrite)\b|\bBun\.write\b|\b(?:File|IO)\.write\b|O_(?:WRONLY|RDWR|CREAT)/;
const OPEN_SYNC_FOR_WRITING = /\b(?:openSync|fopen)\s*\([^)]*['"][wax]/;
const RUBY_FILE_OPEN_FOR_WRITING = /\bFile\.open\s*\(?[^)]*['"][wa]/;
const PERL_OPEN_FOR_WRITING = /\bopen\s*\(?[^;]*['"]\s*\+?>/;
const SHELLS_OUT = /\b(?:os\.system|subprocess|popen|child_process|execSync|spawnSync|exec_sync|system)\b/;
const SHELL_WRITE_TEXT = /[^-=>]>{1,2}\s*[\w./"'$~]|\btee\b|\bsed\s+-i|\bdd\s/;
const DECODES_A_PAYLOAD = /b64decode|unhexlify|fromhex|zlib\.decompress|marshal\.loads|\batob\s*\(|Buffer\.from\([^)]*['"](?:base64|hex)['"]/;
const RUNS_DECODED_CODE = /\b(?:exec|eval|compile|Function)\s*\(|\bimport\b|\brequire\b/;

const CODE_WRITE_PATTERNS: readonly RegExp[] = [
  OPEN_FOR_WRITING, OPEN_WITH_MODE_KEYWORD, PATH_OPEN_FOR_WRITING, ALIASED_OPEN_FOR_WRITING, WRITE_CALLS, OPEN_SYNC_FOR_WRITING,
  RUBY_FILE_OPEN_FOR_WRITING, PERL_OPEN_FOR_WRITING,
];

const isOption = (arg: string): boolean => arg.startsWith('-') && arg.length > 1;
const operandsOf = (args: readonly string[]): string[] => args.filter((arg) => !isOption(arg));

function isHarmlessTarget(target: string, scope: ReadScope): boolean {
  const isDevice = HARMLESS_DEVICES.has(target) || target.startsWith(DESCRIPTOR_DEVICE_PREFIX);
  return isDevice || isReadableUnderRoots(target, scope);
}

function redirectWritesFileOutside(redirect: CommandRedirect, scope: ReadScope): boolean {
  const { operator, target } = redirect;
  const isDescriptorDuplication = operator === '>&' && DESCRIPTOR_TARGET.test(target);
  const writesAFile = !isDescriptorDuplication && (FILE_WRITING_REDIRECTS.has(operator) || operator === '>&');
  return writesAFile && target !== '' && !isHarmlessTarget(target, scope);
}

function sedRewritesFileOutside(args: readonly string[], scope: ReadScope, { namesFilesOnStdin }: { namesFilesOnStdin: boolean }): boolean {
  const rewritesInPlace = args.some((arg) => arg.startsWith('--in-place') || (isOption(arg) && !arg.startsWith('--') && arg.includes('i')));
  if (!rewritesInPlace) return false;
  const scriptCount = Math.max(1, args.filter((arg) => SED_SCRIPT_OPTIONS.has(arg)).length);
  const files = operandsOf(args).slice(scriptCount);
  if (namesFilesOnStdin && files.length === 0) return true;
  return files.some((file) => !isHarmlessTarget(file, scope));
}

function ddWritesFileOutside(args: readonly string[], scope: ReadScope): boolean {
  const outputs = args.filter((arg) => arg.startsWith('of=')).map((arg) => arg.slice('of='.length));
  return outputs.some((output) => !isHarmlessTarget(output, scope));
}

function hasInlineCode(args: readonly string[]): boolean {
  const isCodeOption = (arg: string): boolean => INLINE_CODE_OPTION.test(arg) || INLINE_CODE_LONG_OPTIONS.some((option) => arg === option || arg.startsWith(`${option}=`));
  return args.some(isCodeOption) || INLINE_CODE_SUBCOMMANDS.has(args[0] ?? '');
}

function codeTextOf(command: SimpleCommand): string {
  const stdinScripts = command.redirects.flatMap((redirect) => {
    if (redirect.operator === '<<') return [redirect.heredocBody ?? ''];
    return redirect.operator === '<<<' ? [redirect.target] : [];
  });
  return [...(hasInlineCode(command.args) ? command.args : []), ...stdinScripts].join('\n');
}

function codeWritesAFile(code: string): boolean {
  if (CODE_WRITE_PATTERNS.some((pattern) => pattern.test(code))) return true;
  const shellsOutToAWrite = SHELLS_OUT.test(code) && SHELL_WRITE_TEXT.test(code);
  const runsAHiddenPayload = DECODES_A_PAYLOAD.test(code) && RUNS_DECODED_CODE.test(code);
  return shellsOutToAWrite || runsAHiddenPayload;
}

function interpreterWritesAFile(command: SimpleCommand): boolean {
  const isPerlInPlace = command.program === 'perl' && command.args.some((arg) => PERL_IN_PLACE_OPTION.test(arg));
  return isPerlInPlace || codeWritesAFile(codeTextOf(command));
}

function programWritesFileOutside(command: SimpleCommand, scope: ReadScope): boolean {
  const { program, args } = command;
  const namesFilesOnStdin = command.wrappers.includes('xargs');
  if (program === 'tee') return (namesFilesOnStdin && operandsOf(args).length === 0) || operandsOf(args).some((file) => !isHarmlessTarget(file, scope));
  if (program === 'sed') return sedRewritesFileOutside(args, scope, { namesFilesOnStdin });
  if (program === 'dd') return ddWritesFileOutside(args, scope);
  return INTERPRETER_PROGRAM.test(program) && interpreterWritesAFile(command);
}

/**
 * Tells whether a simple command writes file content outside the given roots: a redirect to a file, `tee`, `sed -i`,
 * `dd of=`, or an interpreter whose inline or here-document code opens a file for writing. Devices such as /dev/null,
 * descriptor duplications (`2>&1`) and paths inside the roots are not writes.
 */
export function writesFileOutside(command: SimpleCommand, scope: ReadScope): boolean {
  return command.redirects.some((redirect) => redirectWritesFileOutside(redirect, scope)) || programWritesFileOutside(command, scope);
}
