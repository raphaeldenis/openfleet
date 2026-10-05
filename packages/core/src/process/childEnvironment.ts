import { EXIT_ON_STDIN_EOF_VARIABLE } from './stdinEofShutdown.js';

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
  // The desktop app's private switch to its sidecar: a nested dev daemon that inherits it exits on its first stdin EOF.
  EXIT_ON_STDIN_EOF_VARIABLE,
]);

// HOME and XDG_CONFIG_HOME are never stripped: they are how git is meant to find the user's
// own global config, and neither consumer below ever gets them from an attacker-controlled
// test harness — only from the real host environment.

// A git subprocess started with one of these operates on the repository they name instead of
// the one implied by its own cwd — that's how a test's throwaway `git init` once redirected a
// shared checkout's worktree (see git/worktrees.test.ts). Dropped for every git child, the
// daemon's own and the launched CLI's alike: a CLI started in a worktree must use that
// worktree's own repo regardless of what its launcher happened to have set.
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
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
]);

// GIT_CONFIG_COUNT/KEY_n/VALUE_n, GIT_CONFIG_PARAMETERS, GIT_CONFIG_GLOBAL/SYSTEM, and legacy
// GIT_CONFIG can inject core.hooksPath to run an attacker hook — dropped only from the
// daemon's own git calls. The launched CLI keeps them: GIT_CONFIG_GLOBAL=/dev/null or a CI
// identity there is the user's own intent, not an attacker's.
const GIT_CONFIG_INJECTION_VARS = new Set(['GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG']);
const GIT_CONFIG_INDEXED_VAR = /^GIT_CONFIG_(KEY|VALUE)_\d+$/;

// Any of these can name a file git appends its own diagnostics to — dropped only from the
// daemon's own git calls, for the same reason as the config-injection vars above.
const GIT_TRACE_DESTINATION_VARS = new Set([
  'GIT_TRACE',
  'GIT_TRACE2',
  'GIT_TRACE2_EVENT',
  'GIT_TRACE2_PERF',
  'GIT_TRACE_PACKET',
  'GIT_TRACE_PERFORMANCE',
  'GIT_TRACE_SETUP',
  'GIT_TRACE_SHALLOW',
  'GIT_TRACE_CURL',
]);

function scrub(parentEnv: NodeJS.ProcessEnv, alsoDrops: (name: string) => boolean): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(parentEnv).filter(
      ([name, value]) => value !== undefined && !SESSION_MARKERS.has(name) && !GIT_REPOSITORY_LOCATION_VARS.has(name) && !alsoDrops(name),
    ),
  );
}

// The CLI draws into the embedded xterm.js, not into the terminal that launched the daemon. Variables
// naming that host terminal make the CLI assume its keyboard and escape-sequence capabilities (for
// instance the kitty keyboard protocol), which xterm.js does not implement. COLORTERM stays: it
// describes color depth, which xterm.js does support.
const HOST_TERMINAL_IDENTITY_NAMES = new Set([
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERM_SESSION_ID',
  'LC_TERMINAL',
  'LC_TERMINAL_VERSION',
  'VTE_VERSION',
  'WT_SESSION',
  'TMUX',
  'STY',
  '__CFBundleIdentifier',
]);
const HOST_TERMINAL_IDENTITY_PREFIXES = ['KITTY_', 'GHOSTTY_', 'WEZTERM_', 'ITERM_', 'ALACRITTY_'];

function isHostTerminalIdentity(name: string): boolean {
  const isExactIdentityName = HOST_TERMINAL_IDENTITY_NAMES.has(name);
  const hasIdentityPrefix = HOST_TERMINAL_IDENTITY_PREFIXES.some((prefix) => name.startsWith(prefix));
  return isExactIdentityName || hasIdentityPrefix;
}

/** Env for a claude CLI this daemon launches: keeps the user's own git config variables, drops the launching terminal's identity. */
export function childEnvironmentForClaudeCli(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return scrub(parentEnv, isHostTerminalIdentity);
}

/** Env for a git subprocess the daemon runs itself: also strips config-injection and trace vars. */
export function childEnvironmentForGit(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return scrub(
    parentEnv,
    (name) => GIT_CONFIG_INJECTION_VARS.has(name) || GIT_CONFIG_INDEXED_VAR.test(name) || GIT_TRACE_DESTINATION_VARS.has(name),
  );
}
