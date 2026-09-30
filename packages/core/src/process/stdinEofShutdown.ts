export const EXIT_ON_STDIN_EOF_VARIABLE = 'OPENFLEET_EXIT_ON_STDIN_EOF';

/** Runs `shutdown` when the parent closes stdin, only for a daemon started with OPENFLEET_EXIT_ON_STDIN_EOF=1 (the desktop app's sidecar); removes the variable from `env` so no child inherits it. */
export function shutdownOnStdinEof(shutdown: () => void, stdin: NodeJS.ReadableStream, env: NodeJS.ProcessEnv): void {
  const isSidecarOfTheApp = env[EXIT_ON_STDIN_EOF_VARIABLE] === '1';
  delete env[EXIT_ON_STDIN_EOF_VARIABLE];
  if (!isSidecarOfTheApp) return;
  stdin.on('end', shutdown);
  stdin.on('close', shutdown);
  stdin.resume();
}
