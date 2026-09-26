// ponytail: a nested `claude` inherits its parent session's markers and behaves as a child
// (transcript saving off, hooks altered, messaging wired to the wrong socket) — strip them.
// Ceiling: a marker a future CLI version adds leaks through until listed here. Upgrade path:
// run `env | grep CLAUDE` inside a session and extend this Set. A name belongs in this Set
// only when the CLI uses it as session identity, never when it is user configuration.
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
]);

export function childEnvironment(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(parentEnv).filter(([name, value]) => value !== undefined && !SESSION_MARKERS.has(name)),
  );
}
