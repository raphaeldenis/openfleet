import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_PATH = join(REPO_ROOT, '.claude/hooks/block-dangerous-git.py');
const EXIT_ALLOWED = 0;
const EXIT_BLOCKED = 2;

/** Command templates: `<main>` is a checkout on main, `<feature>` a checkout on a feature branch. */
const MAIN_PLACEHOLDER = '<main>';
const FEATURE_PLACEHOLDER = '<feature>';

let sandbox = '';
let mainCheckout = '';
let featureCheckout = '';

const initCheckoutOnBranch = (path: string, branch: string) => {
  spawnSync('git', ['init', '-q', '-b', branch, path], { encoding: 'utf8' });
};

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'block-dangerous-git-'));
  mainCheckout = join(sandbox, 'main-checkout');
  featureCheckout = join(sandbox, 'feature-checkout');
  initCheckoutOnBranch(mainCheckout, 'main');
  initCheckoutOnBranch(featureCheckout, 'feature/x');
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const fillPlaceholders = (template: string) => template.replaceAll(MAIN_PLACEHOLDER, mainCheckout).replaceAll(FEATURE_PLACEHOLDER, featureCheckout);

const runHookOnRawPayload = (payload: string) => spawnSync('python3', ['-I', HOOK_PATH], { input: payload, encoding: 'utf8' });

const hookExitCode = (template: string, workingDirectory: string) => {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: fillPlaceholders(template) }, cwd: workingDirectory });
  return runHookOnRawPayload(payload).status;
};

const ALLOWED_FROM_FEATURE_CHECKOUT = [
  'git status --short',
  'git log --oneline -5',
  'git diff 054b90f8..HEAD --stat',
  'git add a.ts',
  'git commit -m "fix(x): y"',
  'git commit -m "docs: explain why git reset --hard is blocked"',
  'git cherry-pick 1c84c72c',
  'git cherry-pick -n abc',
  'git checkout -b feature/x',
  'git switch -c x',
  'git restore --staged f',
  'git -C <feature> status --short',
  'git -C <feature> push https://github.com/raphaeldenis/openfleet.git integration-night-lot45:integration-night-lot45',
  'git push https://github.com/raphaeldenis/openfleet.git night3:night3',
  'git fetch https://github.com/raphaeldenis/openfleet.git main',
  'git merge-base --is-ancestor 6eccbeeb HEAD',
  'git stash list',
  'git branch --list',
  'git worktree list',
  'git rebase --abort',
  'git grep -n "no-verify" -- scripts',
  'gh pr create --draft --base main --head x --title t --body-file f',
  'gh pr merge 350 --merge',
  'pnpm exec vitest run x',
  'env PATH=/opt/homebrew/bin:/usr/bin:/bin pnpm --filter @openfleet/core exec tsc --noEmit',
  '',
  'git push',
  'git push origin HEAD',
  'cd <feature> && git push',
];

const BLOCKED_FROM_FEATURE_CHECKOUT_ALREADY_BEFORE_FOLLOWUP = [
  'git push --force origin x',
  'git push -f origin x',
  'git push --force-with-lease origin x',
  'git push --force-if-includes origin x',
  'git push origin +x:x',
  'git push origin main',
  'git push origin HEAD:main',
  'git push origin HEAD:refs/heads/master',
  'git push origin :x',
  'git push --delete origin x',
  'git push --no-verify origin x',
  'git commit --no-verify -m x',
  'git commit -n -m x',
  'git commit -nm x',
  'git reset --hard',
  'git reset --hard HEAD~1',
  'git clean -fd',
  'git branch -D x',
  'git branch -d -f x',
  'git filter-branch --tree-filter true',
  'git filter-repo --path x',
  'git stash drop',
  'git stash clear',
  'git checkout -- f',
  'git checkout .',
  'git checkout -f x',
  'git restore .',
  'git restore f',
  'git rebase feature/y main',
  'git worktree remove --force x',
  "sh -c 'git reset --hard'",
  'echo ok && git reset --hard',
  'eval "git reset --hard"',
  'cat <<EOF\n$(git reset --hard)\nEOF',
  'cat <<\'EOF\'\nbody\nEOF\ngit reset --hard',
  'echo "<<EOF"\ngit reset --hard\nEOF',
];

const BLOCKED_FROM_FEATURE_CHECKOUT_BY_TARGET_DIRECTORY = [
  'git -C <main> push origin HEAD',
  'git -C <main> push',
  'git --git-dir=<main>/.git push',
  'git --git-dir <main>/.git push',
  'cd <main> && git push',
  'git -C ../main-checkout push',
  'git -C /nonexistent/directory push',
  'cd /nonexistent/directory && git push',
  'cd $SOMEWHERE && git push',
];

const BLOCKED_FROM_FEATURE_CHECKOUT_BY_HOOK_SKIPPING = [
  'HUSKY=0 git push origin x',
  'HUSKY=0 git commit -m x',
  'HUSKY_SKIP_HOOKS=1 git commit -m x',
  'env HUSKY=0 git push origin x',
  'export HUSKY=0 && git commit -m x',
  'git -c core.hooksPath=/dev/null commit -m x',
  'git -c core.hooksPath=/dev/null push origin x',
  'git -c core.hookspath=/dev/null commit -m x',
  'git -c CORE.HOOKSPATH=/dev/null push origin x',
  'git -ccore.hooksPath=/dev/null commit -m x',
  'git --config-env=core.hooksPath=NOHOOKS commit -m x',
  'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x',
  'GIT_DIR=<main>/.git git push',
  'git config core.hooksPath /dev/null',
];

const ALLOWED_DESPITE_RESEMBLING_HOOK_SKIPPING = [
  'HUSKY=0 pnpm install',
  'git -c user.name=x commit -m y',
  'git commit -m "docs: HUSKY=0 skips the hooks"',
  'git config user.name x',
];

const ALLOWED_DESPITE_MENTIONING_GIT_INSIDE_OTHER_TEXT = [
  "echo it's git",
  "pnpm test # don't forget git",
  'cat <<\'EOF\'\ngit reset --hard is blocked now\nEOF',
  'cat <<EOF\ngit push --force is documented here\nEOF',
  'git commit -F - <<\'EOF\'\nfix(x): y\n\ngit reset --hard is documented\nEOF',
  'cat <<-EOF\n\tgit clean -fd\n\tEOF',
];

const BLOCKED_WHEN_QUOTING_HIDES_A_GIT_COMMAND = [
  'git commit -m "it\'s',
  "env git push -f 'x",
  "sudo git reset --hard 'x",
  "bash -c 'git reset --hard",
  "HUSKY=0 git push 'x",
];

const BLOCKED_BEHIND_SHELL_GROUPING_OR_FORCING_FLAGS = [
  '{ git reset --hard; }',
  '! git reset --hard',
  'if git push -f origin x; then echo ok; fi',
  'for f in a; do git reset --hard; done',
  'while true; do git clean -fd; done',
  'git switch -f main',
  'git switch --discard-changes x',
  'git switch --force x',
  'git branch -f main HEAD~1',
  'git branch --force master abc',
];

const ALLOWED_BEHIND_SHELL_GROUPING = [
  '{ git status; }',
  '! git diff --quiet',
  'if git diff --quiet; then echo clean; fi',
  'git branch feature/y',
  'git branch -f feature/y abc',
  'git switch x',
];

describe('block-dangerous-git hook', () => {
  it.each(ALLOWED_FROM_FEATURE_CHECKOUT)('allows %j', (command) => {
    expect(hookExitCode(command, featureCheckout)).toBe(EXIT_ALLOWED);
  });

  it.each(BLOCKED_FROM_FEATURE_CHECKOUT_ALREADY_BEFORE_FOLLOWUP)('blocks %j', (command) => {
    expect(hookExitCode(command, featureCheckout)).toBe(EXIT_BLOCKED);
  });

  it('blocks a malformed payload (fails closed)', () => {
    expect(runHookOnRawPayload('{not json').status).toBe(EXIT_BLOCKED);
  });

  describe('hook-skipping forms', () => {
    it.each(BLOCKED_FROM_FEATURE_CHECKOUT_BY_HOOK_SKIPPING)('blocks %j', (command) => {
      expect(hookExitCode(command, featureCheckout)).toBe(EXIT_BLOCKED);
    });

    it.each(ALLOWED_DESPITE_RESEMBLING_HOOK_SKIPPING)('allows %j', (command) => {
      expect(hookExitCode(command, featureCheckout)).toBe(EXIT_ALLOWED);
    });
  });

  describe('shell grouping and forcing flags', () => {
    it.each(BLOCKED_BEHIND_SHELL_GROUPING_OR_FORCING_FLAGS)('blocks %j', (command) => {
      expect(hookExitCode(command, featureCheckout)).toBe(EXIT_BLOCKED);
    });

    it.each(ALLOWED_BEHIND_SHELL_GROUPING)('allows %j', (command) => {
      expect(hookExitCode(command, featureCheckout)).toBe(EXIT_ALLOWED);
    });
  });

  describe('text that only mentions git', () => {
    it.each(ALLOWED_DESPITE_MENTIONING_GIT_INSIDE_OTHER_TEXT)('allows %j', (command) => {
      expect(hookExitCode(command, featureCheckout)).toBe(EXIT_ALLOWED);
    });

    it.each(BLOCKED_WHEN_QUOTING_HIDES_A_GIT_COMMAND)('blocks the unparsable %j', (command) => {
      expect(hookExitCode(command, featureCheckout)).toBe(EXIT_BLOCKED);
    });
  });

  describe('branch check follows the directory git runs in', () => {
    it.each(BLOCKED_FROM_FEATURE_CHECKOUT_BY_TARGET_DIRECTORY)('blocks %j from a feature checkout', (command) => {
      expect(hookExitCode(command, featureCheckout)).toBe(EXIT_BLOCKED);
    });

    it.each(['git -C <feature> push', 'cd <feature> && git push', 'git --git-dir=<feature>/.git push'])('allows %j from the main checkout', (command) => {
      expect(hookExitCode(command, mainCheckout)).toBe(EXIT_ALLOWED);
    });

    it('blocks a bare push from the main checkout', () => {
      expect(hookExitCode('git push', mainCheckout)).toBe(EXIT_BLOCKED);
    });
  });
});
