import { InjectionToken } from '@angular/core';

export type AppVersionReader = () => Promise<string>;

const BROWSER_VERSION = 'dev';

async function readVersionFromTauri(): Promise<string> {
  const isTauriWebview = '__TAURI_INTERNALS__' in globalThis;
  if (!isTauriWebview) return BROWSER_VERSION;
  const { getVersion } = await import('@tauri-apps/api/app');
  return getVersion();
}

/** Reads the version of this app: the bundle version under Tauri, "dev" in a plain browser. */
export const APP_VERSION_READER = new InjectionToken<AppVersionReader>('APP_VERSION_READER', {
  providedIn: 'root',
  factory: () => readVersionFromTauri,
});
