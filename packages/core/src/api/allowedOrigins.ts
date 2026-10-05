// The desktop shell's own origins: the Angular dev server, and the Tauri webview in both its dev and packaged
// forms. OPENFLEET_ALLOWED_ORIGINS adds loopback web origins (a dev or e2e web server on a free port).
// Shared between CORS (server.ts) and the /ws upgrade check (wsHandler.ts) so the two never drift apart.
const DESKTOP_SHELL_ORIGINS = ['http://localhost:1420', 'tauri://localhost', 'http://tauri.localhost'];
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isLoopbackHttpOrigin(candidate: string): boolean {
  const url = URL.canParse(candidate) ? new URL(candidate) : null;
  if (!url) return false;
  const isHttp = url.protocol === 'http:';
  const isLoopback = LOOPBACK_HOSTNAMES.has(url.hostname);
  const hasExplicitPort = url.port !== '';
  const isBareOrigin = url.origin === candidate;
  return isHttp && isLoopback && hasExplicitPort && isBareOrigin;
}

export function buildAllowedOrigins(env: NodeJS.ProcessEnv): Set<string> {
  const configuredOrigins = (env.OPENFLEET_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim());
  const extraLoopbackOrigins = configuredOrigins.filter(isLoopbackHttpOrigin);
  return new Set([...DESKTOP_SHELL_ORIGINS, ...extraLoopbackOrigins]);
}

export const ALLOWED_ORIGINS = buildAllowedOrigins(process.env);
