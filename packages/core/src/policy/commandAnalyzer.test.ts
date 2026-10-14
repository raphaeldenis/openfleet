import { describe, expect, it } from 'vitest';
import { analyzeCommand, MAX_COMMAND_CHARS, MAX_COMMANDS, MAX_NESTING_DEPTH, type SimpleCommand } from './commandAnalyzer.js';

const render = (command: SimpleCommand): string => [command.program, ...command.args].join(' ');
const rendered = (text: string): string[] => analyzeCommand(text).commands.map(render);
const find = (text: string, program: string): SimpleCommand | undefined =>
  analyzeCommand(text).commands.find((command) => command.program === program);

describe('analyzeCommand: separators and pipes', () => {
  it.each([
    ['ls | grep x', ['ls', 'grep x']],
    ['a && b || c; d & e', ['a', 'b', 'c', 'd', 'e']],
    ['a |& b', ['a', 'b']],
    ['a\nb\n\nc', ['a', 'b', 'c']],
    ['', []],
    ['   ;  ; ', []],
  ])('splits %j into %j', (text, expected) => {
    expect(rendered(text)).toEqual(expected);
  });

  it('marks the command after a pipe as fed by it, and only that one', () => {
    const fedByPipe = analyzeCommand('a | b && c | d ; e').commands.map((command) => [command.program, command.fedByPipe]);

    expect(fedByPipe).toEqual([['a', false], ['b', true], ['c', false], ['d', true], ['e', false]]);
  });

  it('marks the first command of a group that follows a pipe as fed by it', () => {
    const fedByPipe = analyzeCommand('a | (b; c)').commands.map((command) => [command.program, command.fedByPipe]);

    expect(fedByPipe).toEqual([['a', false], ['b', true], ['c', false]]);
  });
});

describe('analyzeCommand: quotes and escapes never split a command', () => {
  it.each([
    ["echo 'a|b;c&&d'", ['a|b;c&&d']],
    ['echo "a|b;c&&d"', ['a|b;c&&d']],
    ["echo $'a\\'b;c'", ["a'b;c"]],
    ['echo a\\;b', ['a;b']],
    ['echo "say \\"hi\\"; ls"', ['say "hi"; ls']],
    ["echo 'a\\' ; ls", null],
    ['echo a#b', ['a#b']],
    ['echo "multi\nline | text"', ['multi\nline | text']],
    ['echo a\\\nb', ['ab']],
  ])('reads %j', (text, expectedArgs) => {
    const commands = analyzeCommand(text).commands;

    if (expectedArgs === null) {
      expect(commands.map((command) => command.program)).toEqual(['echo', 'ls']);
      return;
    }
    expect(commands).toHaveLength(1);
    expect(commands[0]?.args).toEqual(expectedArgs);
  });

  it('expands ANSI-C escapes so an encoded program name is still seen', () => {
    expect(find("$'\\x72m' -rf x", 'rm')?.args).toEqual(['-rf', 'x']);
  });

  it('removes the quotes of a program name', () => {
    expect(find("'rm' -rf x", 'rm')?.args).toEqual(['-rf', 'x']);
    expect(find('\\rm -rf x', 'rm')?.args).toEqual(['-rf', 'x']);
  });

  it('does not treat a comment as commands but keeps a hash inside a word', () => {
    expect(rendered('ls # rm -rf x')).toEqual(['ls']);
  });

  it('joins a line continuation', () => {
    expect(rendered('rm \\\n -rf x')).toEqual(['rm -rf x']);
  });
});

describe('analyzeCommand: substitutions', () => {
  it.each([
    ['echo $(rm -rf x)', 'dollar parenthesis'],
    ['echo `rm -rf x`', 'backticks'],
    ['echo "result: $(rm -rf x)"', 'inside double quotes'],
    ['echo "result: `rm -rf x`"', 'backticks inside double quotes'],
    ['echo $(echo $(rm -rf x))', 'nested'],
    ['cat <(rm -rf x)', 'process substitution'],
    ['X=$(rm -rf x) true', 'an assignment value'],
    ['echo ${HOME:-$(rm -rf x)}', 'a parameter default'],
  ])('finds the command inside %s', (text) => {
    const found = find(text, 'rm');

    expect(found?.args).toEqual(['-rf', 'x']);
    expect(found?.origin).toBe('substitution');
  });

  it.each([
    ["echo '$(rm -rf x)'"],
    ["echo '`rm -rf x`'"],
    ['echo $((1 + 2))'],
  ])('does not run %j', (text) => {
    expect(find(text, 'rm')).toBeUndefined();
  });

  it('keeps an unexpanded variable in the arguments', () => {
    expect(find('rm $R x', 'rm')?.args).toEqual(['$R', 'x']);
  });

  it('unescapes backticks before reading their content', () => {
    expect(find('echo `echo \\`rm -rf x\\``', 'rm')?.args).toEqual(['-rf', 'x']);
  });
});

describe('analyzeCommand: groups and compound commands', () => {
  it('reads the commands of a subshell and labels them', () => {
    const commands = analyzeCommand('(cd a; rm -rf x) && ls').commands;

    expect(commands.map((command) => [command.program, command.origin])).toEqual([
      ['cd', 'subshell'], ['rm', 'subshell'], ['ls', 'top'],
    ]);
  });

  it.each([
    ['{ rm -rf x; }'],
    ['if true; then rm -rf x; fi'],
    ['for f in a b; do rm -rf $f; done'],
    ['while true; do rm -rf x; done'],
    ['! rm -rf x'],
    ['true && { rm -rf x; }'],
  ])('reaches the command inside %j', (text) => {
    expect(find(text, 'rm')?.args.slice(0, 1)).toEqual(['-rf']);
  });

  it('survives unbalanced parentheses without throwing', () => {
    expect(() => analyzeCommand('case x in a) rm -rf y;; esac)')).not.toThrow();
    expect(find('case x in a) rm -rf y;; esac', 'rm')).toBeDefined();
  });
});

describe('analyzeCommand: inline shells and eval', () => {
  it.each([
    "bash -c 'rm -rf x'",
    'sh -c "rm -rf x"',
    "zsh -c 'rm -rf x'",
    "bash -lc 'rm -rf x'",
    "sh -ec 'rm -rf x'",
    "dash -c 'rm -rf x'",
    "/bin/bash -c 'rm -rf x'",
    "bash -o pipefail -c 'rm -rf x'",
    "bash --norc -c 'rm -rf x'",
    "env FOO=1 bash -c 'rm -rf x'",
  ])('reads the script of %j', (text) => {
    const found = find(text, 'rm');

    expect(found?.origin).toBe('inline_shell');
    expect(found?.depth).toBe(1);
  });

  it('keeps the shell command itself in the result', () => {
    expect(rendered("bash -c 'ls -la'")).toEqual(["bash -c ls -la", 'ls -la']);
  });

  it('reads nested inline shells with their depth', () => {
    const found = find(`sh -c "bash -c 'rm -rf x'"`, 'rm');

    expect(found?.depth).toBe(2);
    expect(found?.origin).toBe('inline_shell');
  });

  it('does not read a script file as an inline script', () => {
    expect(rendered('sh script.sh')).toEqual(['sh script.sh']);
  });

  it.each([["eval 'rm -rf x'"], ['eval rm -rf x']])('reads the script of %j as eval', (text) => {
    expect(find(text, 'rm')?.origin).toBe('eval');
  });

  it('reads the substitution that builds an eval script', () => {
    expect(find('eval "$(echo rm -rf x)"', 'echo')?.origin).toBe('substitution');
  });
});

describe('analyzeCommand: heredocs', () => {
  it('treats the body of a heredoc as data', () => {
    expect(rendered('cat <<EOF\nrm -rf x\nEOF')).toEqual(['cat']);
  });

  it('reads substitutions in an unquoted heredoc body', () => {
    const found = find('cat <<EOF\nhello $(rm -rf x)\nEOF', 'rm');

    expect(found?.origin).toBe('substitution');
  });

  it.each([
    ["cat <<'EOF'\n$(rm -rf x)\nEOF"],
    ['cat <<"EOF"\n$(rm -rf x)\nEOF'],
    ['cat <<\\EOF\n$(rm -rf x)\nEOF'],
  ])('keeps a quoted heredoc body as data: %j', (text) => {
    expect(find(text, 'rm')).toBeUndefined();
  });

  it('accepts an indented terminator with <<-', () => {
    expect(rendered('cat <<-EOF\n\tbody\n\tEOF\nls')).toEqual(['cat', 'ls']);
  });

  it('keeps parsing the line that carries the heredoc operator', () => {
    const commands = analyzeCommand('cat <<EOF | grep x && ls\nbody\nEOF\nrm y').commands;

    expect(commands.map((command) => [command.program, command.fedByPipe])).toEqual([
      ['cat', false], ['grep', true], ['ls', false], ['rm', false],
    ]);
  });

  it('reads two heredocs opened on the same line in order', () => {
    const analysis = analyzeCommand('cat <<A <<B\nfirst\nA\nsecond\nB\nls');

    expect(analysis.status).toBe('complete');
    expect(analysis.commands.map((command) => command.program)).toEqual(['cat', 'ls']);
  });

  it.each([
    ['bash <<EOF\nrm -rf x\nEOF'],
    ["sh -s <<'EOF'\nrm -rf x\nEOF"],
    ["bash <<< 'rm -rf x'"],
  ])('reads the body fed to a shell as a script: %j', (text) => {
    expect(find(text, 'rm')?.origin).toBe('heredoc_script');
  });

  it('records the heredoc operator and delimiter on the command', () => {
    const [cat] = analyzeCommand('cat <<EOF\nbody\nEOF').commands;

    expect(cat?.redirects).toMatchObject([{ operator: '<<', target: 'EOF' }]);
  });
});

describe('analyzeCommand: redirections', () => {
  it.each([
    ['echo hi > f', '>', 'f', undefined],
    ['echo hi >> f', '>>', 'f', undefined],
    ['echo hi >| f', '>|', 'f', undefined],
    ['echo hi &> f', '&>', 'f', undefined],
    ['echo hi 2> err', '>', 'err', 2],
    ['echo hi 2>&1', '>&', '1', 2],
    ['cat < in', '<', 'in', undefined],
    ['cat <<< word', '<<<', 'word', undefined],
    ['echo hi >.git/x', '>', '.git/x', undefined],
    ['echo hi > ".git/x"', '>', '.git/x', undefined],
  ])('reads %j', (text, operator, target, fd) => {
    const [command] = analyzeCommand(text).commands;

    expect(command?.redirects).toEqual([expect.objectContaining({ operator, target, ...(fd === undefined ? {} : { fd }) })]);
    expect(command?.args.join(' ')).not.toContain(target);
  });

  it('keeps a separated digit as an argument and not as a file descriptor', () => {
    const [command] = analyzeCommand('echo 2 > f').commands;

    expect(command?.args).toEqual(['2']);
    expect(command?.redirects[0]?.fd).toBeUndefined();
  });

  it('reads a redirection written before the program', () => {
    const [command] = analyzeCommand('> f echo hi').commands;

    expect(render(command as SimpleCommand)).toBe('echo hi');
    expect(command?.redirects[0]?.target).toBe('f');
  });
});

describe('analyzeCommand: transparent wrappers', () => {
  it.each([
    ['/bin/rm -rf x'],
    ['env rm -rf x'],
    ['env -i FOO=1 rm -rf x'],
    ['rtk rm -rf x'],
    ['rtk proxy rm -rf x'],
    ['time rm -rf x'],
    ['nohup rm -rf x'],
    ['nice -n 5 rm -rf x'],
    ['command rm -rf x'],
    ['exec rm -rf x'],
    ['xargs rm -rf'],
    ['xargs -n 1 rm -rf'],
    ['FOO=1 BAR=2 rm -rf x'],
  ])('sees the program behind %j', (text) => {
    expect(find(text, 'rm')).toBeDefined();
  });

  it('records the wrappers it looked through', () => {
    expect(find('env nice -n 5 rm x', 'rm')?.wrappers).toEqual(['env', 'nice']);
    expect(find('rm x', 'rm')?.wrappers).toEqual([]);
  });

  it('records the assignments in front of the program', () => {
    expect(find('FOO=1 BAR="a b" rm x', 'rm')?.assignments).toEqual(['FOO=1', 'BAR=a b']);
    expect(find('env FOO=1 rm x', 'rm')?.assignments).toEqual(['FOO=1']);
  });

  it('reads the command run by find -exec', () => {
    const commands = analyzeCommand('find . -name x -exec rm -rf {} \\;').commands;

    expect(commands.map((command) => command.program)).toEqual(['find', 'rm']);
    expect(commands[1]?.args).toEqual(['-rf', '{}']);
  });

  it('does not treat an assignment-only line as a command', () => {
    expect(rendered('R=-rf')).toEqual([]);
  });
});

describe('analyzeCommand: partial reads', () => {
  it.each([
    ["echo 'unterminated"],
    ['echo "unterminated'],
    ['echo $(rm -rf x'],
    ['echo `rm -rf x'],
    ['echo ${HOME'],
    ['cat <<EOF\nno terminator'],
    ['cat <<'],
  ])('flags %j as partial and keeps what is readable', (text) => {
    const analysis = analyzeCommand(text);

    expect(analysis.status).toBe('partial');
    expect(analysis.commands.length).toBeGreaterThan(0);
  });

  it('still finds a forced rm inside an unclosed substitution', () => {
    expect(find('echo $(rm -rf x', 'rm')?.args).toEqual(['-rf', 'x']);
  });

  it.each([
    ['ls -la'],
    ["echo 'a|b'"],
    ['(a; b)'],
    ['cat <<EOF\nok\nEOF'],
  ])('reports %j as complete', (text) => {
    expect(analyzeCommand(text).status).toBe('complete');
  });
});

describe('analyzeCommand: limits', () => {
  it('refuses a command above the size limit without reading it', () => {
    const analysis = analyzeCommand(`rm -rf ${'x'.repeat(MAX_COMMAND_CHARS)}`);

    expect(analysis).toEqual({ status: 'limit_exceeded', commands: [] });
  });

  it('reads a command exactly at the size limit', () => {
    const atLimit = `echo ${'x'.repeat(MAX_COMMAND_CHARS - 5)}`;

    expect(analyzeCommand(atLimit).status).toBe('complete');
  });

  it('flags nesting deeper than the limit', () => {
    const nested = Array.from({ length: MAX_NESTING_DEPTH + 1 }).reduce<string>((script) => `sh -c '${script.replaceAll("'", `'\\''`)}'`, 'rm -rf x');

    expect(analyzeCommand(nested).status).toBe('limit_exceeded');
  });

  it('reads nesting exactly at the limit', () => {
    const nested = Array.from({ length: MAX_NESTING_DEPTH }).reduce<string>((script) => `sh -c '${script.replaceAll("'", `'\\''`)}'`, 'rm -rf x');

    expect(find(nested, 'rm')?.depth).toBe(MAX_NESTING_DEPTH);
  });

  it('flags a line with more simple commands than the limit', () => {
    const analysis = analyzeCommand(Array.from({ length: MAX_COMMANDS + 1 }, () => 'a').join(';'));

    expect(analysis.status).toBe('limit_exceeded');
    expect(analysis.commands.length).toBeLessThanOrEqual(MAX_COMMANDS);
  });
});
