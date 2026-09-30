import { computed, inject, Injectable, signal } from '@angular/core';
import { APP_VERSION_READER } from './app-version';

export interface VersionMismatch {
  appVersion: string;
  daemonVersion: string;
}

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

  /** Takes the daemon version from the boot health check, so the daemon is asked once, not once per screen. */
  recordDaemonHealth(health: DaemonHealth): void {
    this.daemonVersion.set(health?.version ?? null);
    this.isDaemonVersionSettled.set(true);
  }
}
