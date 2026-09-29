export type LogLevel = 'info' | 'warn' | 'error';

const CONSOLE_METHOD_BY_LEVEL: Record<LogLevel, 'log' | 'warn' | 'error'> = { info: 'log', warn: 'warn', error: 'error' };

// Never pass headers, tokens or request bodies as `detail`: this is the daemon's one console sink,
// and anything written here is trusted not to carry secrets (see db/README.md's neighbours in spirit).
// Looks up console[method] at call time, not at import time, so tests can still spy on it.
export function log(level: LogLevel, message: string, detail?: unknown): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
  const write = console[CONSOLE_METHOD_BY_LEVEL[level]];
  if (detail === undefined) write(line);
  else write(line, detail);
}
