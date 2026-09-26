// ponytail: a nested `claude` inherits its parent session's markers and behaves as a child
// (transcript saving off, hooks altered, messaging wired to the wrong socket) — strip them.
const CLAUDE_CODE_MARKERS = new Set(['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT']);

export function childEnvironment(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(parentEnv).filter(([name]) => !CLAUDE_CODE_MARKERS.has(name) && !name.startsWith('CLAUDE_CODE_')),
  );
}
