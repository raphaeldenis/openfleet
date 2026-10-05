import { getAdminToken } from '../app/core/admin-token.store.js';

const DEFAULT_API_URL = 'http://127.0.0.1:7331';
const TOKEN_ORIGIN_KEY = 'openfleet.adminToken.origin';
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);
const HTTP_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function normalizeStoredApiUrl(rawApiUrl: string): string | null {
  const trimmedApiUrl = rawApiUrl.trim();
  const hasUserinfoQueryOrFragment = /[@?#]/.test(trimmedApiUrl);
  if (hasUserinfoQueryOrFragment) return null;

  const url = parseUrl(trimmedApiUrl);
  if (!url) return null;
  const isHttp = HTTP_PROTOCOLS.has(url.protocol);
  const isLoopbackDaemon = LOOPBACK_HOSTNAMES.has(url.hostname);
  if (!isHttp || !isLoopbackDaemon) return null;

  const pathWithoutTrailingSlash = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathWithoutTrailingSlash}`;
}

function parseLoopbackDaemonOrigin(rawDaemonUrl: string): string | null {
  const url = parseUrl(rawDaemonUrl);
  if (!url) return null;
  const isPlainHttp = url.protocol === 'http:';
  const isLoopbackDaemon = LOOPBACK_HOSTNAMES.has(url.hostname);
  const hasExplicitPort = url.port !== '';
  const isBareOrigin = url.origin === rawDaemonUrl;
  const isAcceptable = isPlainHttp && isLoopbackDaemon && hasExplicitPort && isBareOrigin;
  return isAcceptable ? url.origin : null;
}

function isTauriWebview(): boolean {
  return '__TAURI_INTERNALS__' in globalThis;
}

function storedApiUrlOrDefault(): string {
  const storedApiUrl = globalThis.localStorage?.getItem('openfleet.apiUrl');
  if (!storedApiUrl) return DEFAULT_API_URL;
  return normalizeStoredApiUrl(storedApiUrl) ?? DEFAULT_API_URL;
}

function storedTokenOrigin(): string | null {
  return globalThis.localStorage?.getItem(TOKEN_ORIGIN_KEY) ?? null;
}

/** Pins the stored token to the daemon the app talks to now, unless it is already pinned. */
function pinStoredTokenToCurrentDaemon(): void {
  const hasStoredToken = (globalThis.localStorage?.getItem('openfleet.adminToken')?.trim() ?? '') !== '';
  const isAlreadyPinned = storedTokenOrigin() !== null;
  if (!hasStoredToken || isAlreadyPinned) return;
  globalThis.localStorage?.setItem(TOKEN_ORIGIN_KEY, storedApiUrlOrDefault());
}

function askToSendTokenTo(daemonOrigin: string): boolean {
  return globalThis.confirm?.(`Use the daemon at ${daemonOrigin}?\n\nYour admin token will be sent to it.`) === true;
}

/**
 * Switches to the daemon named by `?daemon=<loopback http origin>` in a plain browser once the user confirms,
 * handing it the admin token; anything else in that parameter, and the whole parameter inside Tauri, is ignored.
 */
export function adoptDaemonUrlFromQuery(search: string): void {
  if (isTauriWebview()) return;
  const requestedDaemonUrl = new URLSearchParams(search).get('daemon');
  if (requestedDaemonUrl === null) return;
  const daemonOrigin = parseLoopbackDaemonOrigin(requestedDaemonUrl);
  if (!daemonOrigin) return;
  const isCurrentDaemon = daemonOrigin === storedApiUrlOrDefault();
  if (isCurrentDaemon) return;

  pinStoredTokenToCurrentDaemon();
  if (!askToSendTokenTo(daemonOrigin)) return;
  globalThis.localStorage?.setItem('openfleet.apiUrl', daemonOrigin);
  globalThis.localStorage?.setItem(TOKEN_ORIGIN_KEY, daemonOrigin);
}

/** The token is issued by one daemon; it is read as empty everywhere else. */
function tokenIssuedForCurrentDaemon(): string {
  const apiUrl = storedApiUrlOrDefault();
  const inMemoryToken = getAdminToken();
  if (inMemoryToken) return apiUrl === DEFAULT_API_URL ? inMemoryToken : '';
  // Inside Tauri an empty in-memory token stays empty — falling back to localStorage there would defeat
  // the point of keeping the token out of it.
  if (isTauriWebview()) return '';
  pinStoredTokenToCurrentDaemon();
  const isIssuedForOtherDaemon = storedTokenOrigin() !== apiUrl;
  if (isIssuedForOtherDaemon) return '';
  return globalThis.localStorage?.getItem('openfleet.adminToken')?.trim() ?? '';
}

export const environment = {
  get apiUrl(): string {
    return storedApiUrlOrDefault();
  },
  // Tauri sources the real token into memory (admin-token.store.ts) so it never touches localStorage;
  // a plain browser (manual paste, e2e) keeps it in localStorage.
  get adminToken(): string {
    return tokenIssuedForCurrentDaemon();
  },
  get daemonAddress(): string {
    return this.apiUrl.replace(/^\w+:\/\//, '');
  },
};
