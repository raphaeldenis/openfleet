// ponytail: a nested `claude` inherits its launching tool's session markers and behaves as a
// child of that tool (transcript saving off, hooks altered, messaging wired to the wrong
// socket, capabilities hijacked to the wrong session) — strip them. This also covers host
// agent tools that embed Claude Code (e.g. Scape) and pass their own session identity down.
// Ceiling: a marker a future CLI version or embedding host adds leaks through until listed
// here. Upgrade path: run `env | grep CLAUDE` or `env | grep SCAPE` inside a session and
// extend this Set. A name belongs in this Set only when it is the launching tool's session
// identity or capability, never when it is user configuration.
const SESSION_MARKERS = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_JOB_DIR',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_KIND',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
  'SCAPE_SESSION_UUID',
  'SCAPE_PARENT_ARGUS_ID',
  'SCAPE_EDIT_CAP',
  'SCAPE_EDIT_SOCK',
  'SCAPE_EDIT_PUBKEY',
  'SCAPE_EMBEDDED',
  'SCAPE_APP',
]);

// ponytail: a git subprocess started with one of these set operates on the repository they name
// instead of the one implied by its own cwd argument — that's how a test's throwaway `git init`
// once redirected a shared checkout's worktree (see git/worktrees.test.ts). Location only, never
// configuration a git child should keep (GIT_SSH_COMMAND, GIT_AUTHOR_*, GIT_EDITOR, …).
const GIT_REPOSITORY_LOCATION_VARS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_PREFIX',
]);

export function childEnvironment(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(parentEnv).filter(
      ([name, value]) => value !== undefined && !SESSION_MARKERS.has(name) && !GIT_REPOSITORY_LOCATION_VARS.has(name),
    ),
  );
}
