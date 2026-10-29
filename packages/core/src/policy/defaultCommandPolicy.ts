import type { CommandPolicyDocument, PolicyRule, RulePredicate } from '@openfleet/shared';

const GIT_DIR_GLOBS = ['**/.git', '**/.git/**'];
const BROAD_FIND_ROOTS = ['/', '/*', '/Users/*', '/home/*', '~', '~/**', '$HOME', '$HOME/**', '..', '../**'];
const EXPENSIVE_MODELS = ['fable', 'opus'];
const HEAVY_SCRIPT_NAMES = 'test|build|lint|typecheck|type:check|type-check|e2e';
const WORKING_DIRECTORIES = ['{worktree}', '{scratch}', '{toolResults}'];
const FILE_WRITING_TOOLS = ['Write', 'Edit', 'NotebookEdit'];

const noForcedRecursiveRm: PolicyRule = {
  id: 'no-forced-recursive-rm',
  tools: ['Bash'],
  presence: 'unattended',
  decision: 'deny',
  when: { program: 'rm', flags: { all: [['r', 'R', 'recursive'], ['f', 'force']] } },
  reason: 'rm -rf asks for a confirmation nobody sees.',
  alternative: 'Use `rm -r <path>` on a path inside your worktree or scratchpad, or `find <dir> -delete`.',
};

const noForcedGitClean: PolicyRule = {
  id: 'no-forced-git-clean',
  tools: ['Bash'],
  presence: 'unattended',
  decision: 'deny',
  when: { program: 'git', subcommand: 'clean', flags: { all: [['f', 'force']], none: [['n', 'dry-run']] } },
  reason: 'git clean -f deletes files without a visible confirmation.',
  alternative: 'Remove the files you want with `rm <path>` inside your worktree, or tell your manager (message_parent).',
};

const noWriteIntoGitDir: PolicyRule = {
  id: 'no-write-into-git-dir',
  tools: ['Bash', ...FILE_WRITING_TOOLS],
  presence: 'unattended',
  decision: 'deny',
  when: { writesPathMatching: GIT_DIR_GLOBS },
  reason: 'Never write inside a .git directory (worktree or main repository).',
  alternative: 'To ignore a file use the worktree .gitignore, or tell your manager (message_parent).',
};

const noFindDeleteOnBroadPaths: PolicyRule = {
  id: 'no-find-delete-on-broad-paths',
  tools: ['Bash'],
  presence: 'unattended',
  decision: 'deny',
  when: { allOf: [{ program: 'find' }, { argMatching: ['-delete'] }, { argMatching: BROAD_FIND_ROOTS }] },
  reason: 'find -delete on the filesystem root, a home directory or a parent of your worktree deletes outside your work.',
  alternative: 'Run `find <dir> -delete` on a directory inside your worktree or scratchpad.',
};

const noHumanQuestionsUnattended: PolicyRule = {
  id: 'no-human-questions-unattended',
  tools: ['AskUserQuestion', 'ExitPlanMode'],
  presence: 'unattended',
  decision: 'deny',
  when: {},
  reason: 'No human is watching this session, so a question to the user is never answered.',
  alternative: 'Report to your manager with `message_parent` and continue with the safest reading of the task.',
};

const delegateHeavyCommands: PolicyRule = {
  id: 'delegate-heavy-commands',
  tools: ['Bash'],
  harnesses: ['claude-cli'],
  actor: 'session',
  models: EXPENSIVE_MODELS,
  decision: 'deny',
  when: {
    anyOf: [
      {
        commandPrefix: [
          ['pnpm', `test|vitest|build|lint|typecheck|type:check|type-check|e2e`],
          ['pnpm', 'run', HEAVY_SCRIPT_NAMES],
          ['npm', 'test'],
          ['npm', 'run', 'test|build|lint'],
          ['npx', 'vitest|playwright|tsc'],
          ['vitest'],
          ['tsc'],
          ['playwright', 'test'],
          ['cargo', 'test|build|clippy'],
          ['turbo', 'run'],
        ],
      },
      { repoWideSearch: true },
    ],
  },
  reason: 'Heavy mechanical command in the main session.',
  alternative: 'Run it in a Haiku sub-agent (Agent tool, model haiku) and read its condensed result.',
  escape: { commandMarker: '# fix60-ok' },
};

const allowReadOnlyPipelines: PolicyRule = {
  id: 'allow-read-only-pipelines',
  tools: ['Bash'],
  appliesTo: 'everyCommand',
  decision: 'allow',
  when: { readsOnlyWithin: WORKING_DIRECTORIES },
  reason: 'A pipeline that only reads files inside the working directories needs no confirmation.',
};

export const FINDINGS_GATE_RULE_ID = 'findings-gate-pr-create';

const API_CALLS_THAT_MAY_POST: RulePredicate = { flags: { any: [['f'], ['F'], ['X'], ['field'], ['raw-field'], ['method'], ['input']] } };

/**
 * Matches the call only: whether the ticket has its findings is the FindingsGate's answer, given by the hook that sees this rule.
 * A `gh api` call to /pulls with a body or method flag is a candidate; the request parser tells a POST from a read.
 */
const findingsGatePrCreate: PolicyRule = {
  id: FINDINGS_GATE_RULE_ID,
  tools: ['Bash'],
  decision: 'deny',
  when: {
    anyOf: [
      { commandPrefix: [['gh', 'pr', 'create'], ['glab', 'mr', 'create|new']] },
      { allOf: [{ commandPrefix: [['gh', 'api']] }, { argMatching: ['**/pulls*'] }, API_CALLS_THAT_MAY_POST] },
    ],
  },
  reason: 'findings_required: the ticket of this branch lacks the findings that open a pull request.',
  alternative: 'Have QE, QA and the delivery review report on the head commit, or ask your manager for a logged step skip.',
};

const noGitPublish: PolicyRule = {
  id: 'no-git-publish',
  tools: ['Bash'],
  decision: 'deny',
  when: { program: 'git', subcommand: ['commit', 'push'] },
  reason: 'This role verifies the work and does not publish it.',
  alternative: 'Report what you found to your manager with `message_parent`.',
};

const noGitMutations: PolicyRule = {
  id: 'no-git-mutations',
  tools: ['Bash'],
  decision: 'deny',
  when: { anyOf: [{ program: 'git', subcommand: ['commit', 'push', 'reset', 'checkout', 'clean', 'rebase', 'merge'] }, { program: 'rm' }] },
  reason: 'A review leaves the repository exactly as it found it.',
  alternative: 'Describe the change you propose in your report instead of making it.',
};

const noFileWrites: PolicyRule = {
  id: 'no-file-writes',
  tools: FILE_WRITING_TOOLS,
  decision: 'deny',
  when: {},
  reason: 'A review does not modify files.',
  alternative: 'Describe the change you propose in your report instead of making it.',
};

/** The rules delivered with OpenFleet. The role profiles run in observe mode until usage shows which refusals are right. */
export const DEFAULT_COMMAND_POLICY: CommandPolicyDocument = {
  version: 1,
  mode: 'enforce',
  profiles: {
    default: {
      rules: [noForcedRecursiveRm.id, noForcedGitClean.id, noWriteIntoGitDir.id, noFindDeleteOnBroadPaths.id, noHumanQuestionsUnattended.id, findingsGatePrCreate.id, allowReadOnlyPipelines.id],
    },
    dev: { extends: 'default', rules: [delegateHeavyCommands.id] },
    qe: { extends: 'default', rules: [], mode: 'observe' },
    qa: { extends: 'default', rules: [noGitPublish.id], mode: 'observe' },
    review: { extends: 'default', rules: [noFileWrites.id, noGitMutations.id], mode: 'observe' },
  },
  roleToProfile: { DEV: 'dev', QE: 'qe', QA: 'qa', ADV: 'review', REVIEW: 'review' },
  rules: [
    noForcedRecursiveRm, noForcedGitClean, noWriteIntoGitDir, noFindDeleteOnBroadPaths, noHumanQuestionsUnattended,
    findingsGatePrCreate, delegateHeavyCommands, allowReadOnlyPipelines, noGitPublish, noGitMutations, noFileWrites,
  ],
};
