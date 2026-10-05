import { preferPortOrFindFree } from '../ports/freePort.js';

export const DEFAULT_DAEMON_PORT = 7331;

export interface DevDaemonPort { port: number; isFallback: boolean }

/** The port the source daemon listens on: an explicit OPENFLEET_PORT as given, otherwise the default port, or a free one when another process holds it. */
export async function resolveDevDaemonPort({ env, preferredPort = DEFAULT_DAEMON_PORT }: { env: NodeJS.ProcessEnv; preferredPort?: number }): Promise<DevDaemonPort> {
  const explicitPort = env.OPENFLEET_PORT;
  if (explicitPort !== undefined) return { port: Number(explicitPort), isFallback: false };

  const port = await preferPortOrFindFree(preferredPort);
  return { port, isFallback: port !== preferredPort };
}
