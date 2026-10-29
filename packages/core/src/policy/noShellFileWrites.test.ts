import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMAND_POLICY, NO_SHELL_FILE_WRITES_RULE_ID } from './defaultCommandPolicy.js';
import { evaluateCommandPolicy } from './policyEvaluator.js';
import { bashRequest } from './policyRequest.testkit.js';

const WORKTREE = '/work/repo';
const request = (command: string, overrides = {}) => bashRequest(command, { worktreeRoot: WORKTREE, cwd: WORKTREE, ...overrides });

const verdictOf = (command: string, overrides = {}) => evaluateCommandPolicy(request(command, overrides), DEFAULT_COMMAND_POLICY);
const isSteeredToTheEditTools = (command: string, overrides = {}) => {
  const verdict = verdictOf(command, overrides);
  return verdict.decision === 'deny' && verdict.ruleId === NO_SHELL_FILE_WRITES_RULE_ID;
};

describe('the rule that steers file writes to the edit tools', () => {
  it.each([
    ['a heredoc into cat', "cat > notes.md <<'EOF'\nhello\nEOF"],
    ['a heredoc written before the redirect', "cat <<'EOF' > notes.md\nhello\nEOF"],
    ['an append redirect', 'echo hello >> notes.md'],
    ['a clobber redirect', 'echo hello >| notes.md'],
    ['an ampersand redirect to a file', 'echo hello &> notes.md'],
    ['a stderr redirect to a file', 'make 2> errors.txt'],
    ['a redirect with an absolute path', 'echo x > /work/repo/src/a.ts'],
    ['a redirect to an unresolvable variable', 'echo x > "$OUT"'],
    ['a redirect to the home directory', 'echo x > ~/notes.md'],
    ['a redirect that climbs out of .scratch', 'echo x > .scratch/../src/a.ts'],
    ['a redirect into a sibling of .scratch', 'echo x > .scratch-other/a.txt'],
    ['a truncating redirect with no command', '> notes.md'],
    ['tee with a file', 'echo x | tee notes.md'],
    ['tee -a with a file', 'echo x | tee -a notes.md'],
    ['sed -i', "sed -i 's/a/b/' src/a.ts"],
    ['sed -i with a suffix', "sed -i.bak 's/a/b/' src/a.ts"],
    ['sed --in-place', "sed --in-place 's/a/b/' src/a.ts"],
    ['sed -E -i', "sed -E -i 's/a/b/' src/a.ts"],
    ['dd of=', 'dd if=/dev/zero of=out.bin count=1'],
    ['perl -pi', "perl -pi -e 's/a/b/' src/a.ts"],
    ['python3 -c open for writing', "python3 -c \"open('a.txt','w').write('x')\""],
    ['python3 -c with a mode keyword', "python3 -c \"open('a.txt', mode='a').write('x')\""],
    ['python3 -c write_text', "python3 -c \"import pathlib; pathlib.Path('a.txt').write_text('x')\""],
    ['python from a heredoc', "python3 - <<'E'\nopen('a.txt','w').write('x')\nE"],
    ['python from a here-string', "python3 - <<< \"open('a.txt','w').write('x')\""],
    ['node -e writeFileSync', "node -e \"require('fs').writeFileSync('a.txt','x')\""],
    ['node from a heredoc', "node - <<'E'\nrequire('fs').appendFileSync('a.txt','x')\nE"],
    ['ruby -e File.write', "ruby -e \"File.write('a.txt','x')\""],
    ['perl -e open for writing', "perl -e 'open(F, \">a.txt\"); print F 1'"],
  ])('steers %s back to the edit tools', (_label, command) => {
    expect(isSteeredToTheEditTools(command)).toBe(true);
  });

  it.each([
    ['inside a bash -c string', 'bash -c "echo x > notes.md"'],
    ['behind env', 'env FOO=1 tee notes.md'],
    ['behind command', 'command tee notes.md'],
    ['through an absolute program path', 'echo x | /usr/bin/tee notes.md'],
    ['inside eval', 'eval "echo x > notes.md"'],
    ['through xargs', 'echo notes.md | xargs tee'],
    ['in a subshell', '(echo x > notes.md)'],
    ['after a semicolon', 'true; echo x > notes.md'],
    ['after &&', 'true && echo x > notes.md'],
    ['in a command substitution', 'echo "$(echo x > notes.md)"'],
    ['in a group redirected as a whole', '{ echo a; echo b; } > notes.md'],
    ['in a subshell redirected as a whole', '(echo a; echo b) > notes.md'],
    ['in a loop redirected as a whole', 'for f in a b; do echo $f; done > notes.md'],
    ['inside find -exec', "find . -name '*.ts' -exec sed -i 's/a/b/' {} +"],
    ['inside nested shells', "bash -c \"sh -c 'echo x > notes.md'\""],
    ['inside a shell reading its script from a heredoc', "bash <<'E'\necho x > notes.md\nE"],
    ['behind a quoted redirect target', "echo x > 'notes.md'"],
    ['after a leading assignment', 'FOO=1 tee notes.md'],
    ['with a descriptor number before the operator', 'echo x 1> notes.md'],
  ])('catches the write %s', (_label, command) => {
    expect(isSteeredToTheEditTools(command)).toBe(true);
  });

  it.each([
    ['a cat read', 'cat src/a.ts'],
    ['a redirect to /dev/null', 'pnpm test > /dev/null'],
    ['stderr to /dev/null', 'ls missing 2>/dev/null'],
    ['both streams to /dev/null', 'ls missing &>/dev/null'],
    ['stderr joined to stdout', 'pnpm test 2>&1'],
    ['stdout joined to stderr', 'echo oops >&2'],
    ['a redirect to /dev/stderr', 'echo oops > /dev/stderr'],
    ['a redirect to /dev/stdout', 'echo hi > /dev/stdout'],
    ['an input redirect', 'wc -l < src/a.ts'],
    ['a pipeline of reads', 'cat src/a.ts | grep foo | head -n 3'],
    ['a redirect into .scratch', 'pnpm test > .scratch/out.txt 2>&1'],
    ['an append into .scratch', 'pnpm test >> .scratch/out.txt'],
    ['an absolute redirect into the worktree .scratch', 'pnpm test > /work/repo/.scratch/out.txt'],
    ['a redirect into a nested .scratch file', 'pnpm test > .scratch/deep/out.txt'],
    ['tee into .scratch', 'pnpm test | tee .scratch/out.txt'],
    ['tee with no file', 'echo x | tee'],
    ['sed without -i', "sed 's/a/b/' src/a.ts"],
    ['sed -n', "sed -n '1,5p' src/a.ts"],
    ['sed -i on a file in .scratch', "sed -i 's/a/b/' .scratch/out.txt"],
    ['python reading a file', "python3 -c \"print(open('a.txt').read())\""],
    ['python reading in explicit read mode', "python3 -c \"print(open('a.txt','r').read())\""],
    ['python printing to stdout', "python3 -c \"import sys; sys.stdout.write('x')\""],
    ['a python script file', 'python3 scripts/check.py'],
    ['python from a heredoc that only prints', "python3 - <<'E'\nprint(1)\nE"],
    ['node reading a file', "node -e \"console.log(require('fs').readFileSync('a.txt','utf8'))\""],
    ['git status', 'git status --short'],
    ['a quoted arrow in an argument', 'echo "a > b"'],
    ['a comparison in a test', '[ 3 -gt 2 ]'],
    ['grep for a redirect sign', "grep -rn '>' src"],
    ['dd reading only', 'dd if=a.bin bs=1 count=4 | xxd'],
    ['mkdir', 'mkdir -p .scratch/out'],
  ])('lets %s through', (_label, command) => {
    expect(isSteeredToTheEditTools(command)).toBe(false);
  });

  it('uses the scratch roots the request carries', () => {
    const scratchRequest = request('pnpm test > /var/scratch/out.txt', { scratchRoots: ['/var/scratch'] });

    expect(evaluateCommandPolicy(scratchRequest, DEFAULT_COMMAND_POLICY).decision).toBe('allow');
  });

  it('resolves relative targets against the cwd of the command', () => {
    expect(isSteeredToTheEditTools('echo x > out.txt', { cwd: `${WORKTREE}/.scratch` })).toBe(false);
    expect(isSteeredToTheEditTools('echo x > out.txt', { cwd: `${WORKTREE}/src` })).toBe(true);
  });

  it('guides the child to the edit tool instead of asking a human', () => {
    const verdict = verdictOf("cat > notes.md <<'EOF'\nhello\nEOF");

    expect(verdict).toMatchObject({ decision: 'deny', ruleId: NO_SHELL_FILE_WRITES_RULE_ID });
    expect(verdict.decision === 'deny' && verdict.alternative).toMatch(/Write/);
    expect(verdict.decision === 'deny' && verdict.alternative).toMatch(/Edit/);
  });

  it('judges every role: refused for a DEV, observed for a QE whose profile observes', () => {
    const qeVerdict = verdictOf('echo x > notes.md', { role: 'QE' });

    expect(isSteeredToTheEditTools('echo x > notes.md', { role: 'DEV' })).toBe(true);
    expect(qeVerdict).toMatchObject({ decision: 'allow', observed: { ruleId: NO_SHELL_FILE_WRITES_RULE_ID } });
  });

  it('leaves a watched session alone', () => {
    expect(isSteeredToTheEditTools('echo x > notes.md', { presence: 'attended' })).toBe(false);
  });

  it('is observed, not refused, while the policy observes', () => {
    const verdict = evaluateCommandPolicy(request('echo x > notes.md'), { ...DEFAULT_COMMAND_POLICY, mode: 'observe' });

    expect(verdict).toMatchObject({ decision: 'allow', observed: { ruleId: NO_SHELL_FILE_WRITES_RULE_ID } });
  });

  it('does not judge the file tools themselves', () => {
    const verdict = evaluateCommandPolicy(request('', { toolName: 'Write', command: undefined, filePaths: ['/work/repo/a.ts'] }), DEFAULT_COMMAND_POLICY);

    expect(verdict.decision).toBe('allow');
  });
});
