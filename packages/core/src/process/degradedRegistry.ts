import type { DaemonIssue, DegradedCode } from '@openfleet/shared';
import { shortId } from '../ids.js';
import { log } from '../logger.js';
import { maskedSecrets } from '../redact.js';

const MAX_MESSAGE_CHARS = 300;
const HOOK_FAILURES_WINDOW_MS = 5 * 60_000;
const HOOK_FAILURES_TO_MARK = 3;
const UNRENDERABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export type DaemonStatus = 'ok' | 'degraded';

export interface MarkOptions {
  /** The ref of this occurrence; a new one replaces the ref of an issue already marked. Minted when absent and the issue is new. */
  id?: string;
  /** Written to the log, redacted by the logger, never to the issue. */
  cause?: unknown;
}

export interface DegradedRegistry {
  /** Records the issue, or raises its count when already recorded. Never throws. */
  mark(code: DegradedCode, message: string, options?: MarkOptions): void;
  clear(code: DegradedCode): void;
  /** Counts one failing-open hook branch; three within five minutes mark `hook_fail_open`, which clears after five clean minutes. */
  recordHookFailOpen(): void;
  list(): DaemonIssue[];
  status(): DaemonStatus;
  /** Called with the full list when an issue appears, clears, or gets a new ref; not on a mere count bump. */
  onChange(listener: (issues: DaemonIssue[]) => void): () => void;
}

export interface DegradedRegistryOptions {
  /** Epoch milliseconds. */
  clock?: () => number;
}

function callerSafe(message: string): string {
  const printable = maskedSecrets(message.slice(0, MAX_MESSAGE_CHARS * 4)).replace(UNRENDERABLE, '');
  const codePoints = Array.from(printable);
  return codePoints.length <= MAX_MESSAGE_CHARS ? printable : `${codePoints.slice(0, MAX_MESSAGE_CHARS - 1).join('')}…`;
}

export function createDegradedRegistry({ clock = Date.now }: DegradedRegistryOptions = {}): DegradedRegistry {
  const issues = new Map<DegradedCode, DaemonIssue>();
  const listeners = new Set<(issues: DaemonIssue[]) => void>();
  let hookFailureTimes: number[] = [];

  const snapshot = (): DaemonIssue[] => [...issues.values()].map((issue) => ({ ...issue }));
  const announce = (): void => {
    const current = snapshot();
    for (const listener of listeners) {
      try { listener(current); } catch (error) { log('warn', 'degraded registry: a listener threw', error); }
    }
  };

  const clearHookFailuresWhenClean = (): void => {
    const lastFailureTime = hookFailureTimes.at(-1);
    if (lastFailureTime === undefined) return;
    const isClean = clock() - lastFailureTime >= HOOK_FAILURES_WINDOW_MS;
    if (isClean && issues.has('hook_fail_open')) registry.clear('hook_fail_open');
  };

  const registry: DegradedRegistry = {
    mark(code, message, { id, cause } = {}) {
      try {
        const existing = issues.get(code);
        if (existing) {
          const isNewOccurrence = id !== undefined && id !== existing.id;
          issues.set(code, { ...existing, count: existing.count + 1, ...(isNewOccurrence && { id, message: callerSafe(message) }) });
          if (isNewOccurrence) announce();
          return;
        }
        const issue: DaemonIssue = { code, since: new Date(clock()).toISOString(), message: callerSafe(message), id: id ?? shortId(), count: 1 };
        issues.set(code, issue);
        log('warn', `daemon degraded: ${issue.message}`, cause, { id: issue.id, code });
        announce();
      } catch (error) {
        log('warn', 'degraded registry: mark failed', error);
      }
    },

    clear(code) {
      try {
        const cleared = issues.get(code);
        if (!cleared) return;
        issues.delete(code);
        log('info', `daemon recovered: ${code}`, undefined, { id: cleared.id, code });
        announce();
      } catch (error) {
        log('warn', 'degraded registry: clear failed', error);
      }
    },

    recordHookFailOpen() {
      const now = clock();
      hookFailureTimes = [...hookFailureTimes, now].slice(-HOOK_FAILURES_TO_MARK);
      const hasEnoughRecentFailures = hookFailureTimes.length === HOOK_FAILURES_TO_MARK && now - hookFailureTimes[0]! < HOOK_FAILURES_WINDOW_MS;
      if (hasEnoughRecentFailures) registry.mark('hook_fail_open', 'hook answers are failing open; the agents run without the daemon guidance.');
    },

    list() {
      clearHookFailuresWhenClean();
      return snapshot();
    },

    status() {
      return registry.list().length === 0 ? 'ok' : 'degraded';
    },

    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return registry;
}
