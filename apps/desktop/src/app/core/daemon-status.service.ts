import { DestroyRef, inject, Injectable, InjectionToken, signal } from '@angular/core';

const KNOWN_PHASES = ['starting', 'slow', 'ready', 'failed', 'reused'] as const;
export type DaemonPhase = (typeof KNOWN_PHASES)[number];

/** What the Tauri command `daemon_status` answers (camelCase, absent fields omitted). */
export interface DaemonStatus {
  state: DaemonPhase;
  lastLine?: string;
  pathTried?: string;
  pathSource?: 'shell' | 'fallback';
  daemonVersion?: string;
}

/** What the page knows: the daemon's status, a state this app does not know, or nothing when the status could not be read. */
export type ObservedDaemon = DaemonStatus | (Omit<DaemonStatus, 'state'> & { state: 'unknown' | 'unavailable' });

function observedFrom(answer: unknown): ObservedDaemon {
  const state = (answer as { state?: unknown } | null)?.state;
  if (typeof state !== 'string') return { state: 'unavailable' };
  if (KNOWN_PHASES.includes(state as DaemonPhase)) return answer as DaemonStatus;
  const lastLine = (answer as { lastLine?: unknown }).lastLine;
  return { state: 'unknown', lastLine: typeof lastLine === 'string' ? lastLine : undefined };
}

export interface DaemonStatusPort {
  read(): Promise<DaemonStatus>;
}

function readThroughTauri(): DaemonStatusPort | null {
  const isTauriWebview = '__TAURI_INTERNALS__' in globalThis;
  if (!isTauriWebview) return null;
  return {
    async read() {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<DaemonStatus>('daemon_status');
    },
  };
}

/** The port to the Tauri daemon status; null outside Tauri (plain browser, e2e). */
export const DAEMON_STATUS_PORT = new InjectionToken<DaemonStatusPort | null>('DAEMON_STATUS_PORT', {
  providedIn: 'root',
  factory: readThroughTauri,
});

const POLL_INTERVAL_MS = 1000;
const POLL_CAP_MS = 6 * 60 * 1000;
const SETTLED_PHASES: ReadonlyArray<ObservedDaemon['state']> = ['ready', 'reused', 'failed'];

/** Tracks the status of the daemon the app started, reading it every second until it settles or the cap is reached. */
@Injectable()
export class DaemonStatusService {
  private readonly port = inject(DAEMON_STATUS_PORT);
  private pollsLeft = POLL_CAP_MS / POLL_INTERVAL_MS;
  private nextReadTimer: ReturnType<typeof setTimeout> | undefined;
  private isDestroyed = false;

  readonly isUnderTauri = this.port !== null;
  readonly status = signal<ObservedDaemon>({ state: 'starting' });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.isDestroyed = true;
      clearTimeout(this.nextReadTimer);
    });
    void this.readThenScheduleNextRead();
  }

  /** Reads the status now; it cannot restart a failed daemon. */
  refresh(): Promise<void> {
    clearTimeout(this.nextReadTimer);
    return this.readThenScheduleNextRead();
  }

  private async readThenScheduleNextRead(): Promise<void> {
    if (!this.port) return;
    const observed = await this.port.read().then(observedFrom, (): ObservedDaemon => ({ state: 'unavailable' }));
    if (this.isDestroyed) return;
    this.status.set(observed);
    const isSettled = SETTLED_PHASES.includes(observed.state);
    const isCapReached = this.pollsLeft-- <= 0;
    if (isSettled || isCapReached) return;
    clearTimeout(this.nextReadTimer);
    this.nextReadTimer = setTimeout(() => void this.readThenScheduleNextRead(), POLL_INTERVAL_MS);
  }
}
