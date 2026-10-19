import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'openfleet.notifications.v1';

export interface NotificationPrefs {
  enabled: boolean;
  agentFinished: boolean;
  toolCompletion: boolean;
  needsInput: boolean;
  chatMessage: boolean;
  sound: boolean;
  visual: boolean;
  muted: boolean;
  dockBadge: boolean;
}

const DEFAULT_PREFS: NotificationPrefs = {
  enabled: true,
  agentFinished: true,
  toolCompletion: false,
  needsInput: true,
  chatMessage: true,
  sound: false,
  visual: true,
  muted: false,
  dockBadge: true,
};

function readStoredPrefs(): Record<string, unknown> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    const isObject = typeof stored === 'object' && stored !== null && !Array.isArray(stored);
    return isObject ? (stored as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rememberPrefs(prefs: NotificationPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage is unavailable: the preference still applies, it just is not remembered.
  }
}

function prefsFrom(stored: Record<string, unknown>): NotificationPrefs {
  const prefs = { ...DEFAULT_PREFS };
  for (const key of Object.keys(DEFAULT_PREFS) as (keyof NotificationPrefs)[]) {
    const value = stored[key];
    if (typeof value === 'boolean') prefs[key] = value;
  }
  return prefs;
}

/** Owns the notification choices of this device: restores them from local storage and remembers every change. */
@Injectable({ providedIn: 'root' })
export class NotificationPrefsStore {
  private readonly current = signal<NotificationPrefs>(prefsFrom(readStoredPrefs()));
  readonly prefs = this.current.asReadonly();

  set<K extends keyof NotificationPrefs>(key: K, value: NotificationPrefs[K]): void {
    const next = { ...this.current(), [key]: value };
    this.current.set(next);
    rememberPrefs(next);
  }
}
