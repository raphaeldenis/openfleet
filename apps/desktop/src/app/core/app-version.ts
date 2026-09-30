import { InjectionToken, isDevMode } from '@angular/core';

export type AppVersionReader = () => Promise<string>;

const DEV_VERSION = 'dev';

async function readVersionFromTauri(): Promise<string> {
  const isTauriWebview = '__TAURI_INTERNALS__' in globalThis;
  if (!isTauriWebview || isDevMode()) return DEV_VERSION;
  const { getVersion } = await import('@tauri-apps/api/app');
  return getVersion();
}

/** Reads the version of this app: the bundle version in a production Tauri build, "dev" in a development build or a plain browser. */
export const APP_VERSION_READER = new InjectionToken<AppVersionReader>('APP_VERSION_READER', {
  providedIn: 'root',
  factory: () => readVersionFromTauri,
});
