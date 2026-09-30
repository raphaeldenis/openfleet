import { computed, inject, Injectable, signal } from '@angular/core';
import { APP_VERSION_READER } from './app-version';

export interface VersionMismatch {
  appVersion: string;
  daemonVersion: string;
}

const MAX_VERSION_LENGTH = 64;

/** What the daemon answered to the boot health check; null when it did not answer. */
export type DaemonHealth = { version?: string } | null;

/** The version of this app and the version of the daemon it talks to; either stays null while unknown. */
@Injectable({ providedIn: 'root' })
export class VersionsService {
  private readonly readAppVersion = inject(APP_VERSION_READER);
  private loadingAppVersion: Promise<void> | undefined;

  readonly appVersion = signal<string | null>(null);
  readonly daemonVersion = signal<string | null>(null);
  /** True once the app version read has finished, whether or not it found a version. */
  readonly isAppVersionSettled = signal(false);
  /** True once the boot health check has answered or failed. */
  readonly isDaemonVersionSettled = signal(false);
  readonly mismatch = computed<VersionMismatch | null>(() => {
    const appVersion = this.appVersion();
    const daemonVersion = this.daemonVersion();
    const isEitherUnknown = appVersion === null || daemonVersion === null;
    if (isEitherUnknown || appVersion === daemonVersion) return null;
    return { appVersion, daemonVersion };
  });

  /** Reads the app version once; every later call returns the same promise. */
  loadAppVersion(): Promise<void> {
    this.loadingAppVersion ??= this.readAppVersion().then(
      (version) => this.appVersion.set(version),
      () => this.appVersion.set(null),
    ).finally(() => this.isAppVersionSettled.set(true));
    return this.loadingAppVersion;
  }

  /** Takes the daemon version from any successful health answer; a later answer replaces the earlier one. */
  recordDaemonHealth(health: DaemonHealth): void {
    this.daemonVersion.set(displayableVersionOf(health?.version));
    this.isDaemonVersionSettled.set(true);
  }
}

/** Returns the version as a string of at most MAX_VERSION_LENGTH characters, or null when it is not a non-empty string. */
function displayableVersionOf(version: unknown): string | null {
  const isUsable = typeof version === 'string' && version !== '';
  if (!isUsable) return null;
  const isTooLong = version.length > MAX_VERSION_LENGTH;
  return isTooLong ? `${version.slice(0, MAX_VERSION_LENGTH - 1)}…` : version;
}
