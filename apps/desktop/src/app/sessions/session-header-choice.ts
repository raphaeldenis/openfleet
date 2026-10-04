const STORAGE_KEY_PREFIX = 'openfleet.sessionHeader.open.';

function storageKeyOf(sessionId: string): string {
  return STORAGE_KEY_PREFIX + sessionId;
}

/** Returns the user's last open/closed choice for the session, or `null` when none is stored. */
export function readRememberedHeaderChoice(sessionId: string): boolean | null {
  try {
    const stored = localStorage.getItem(storageKeyOf(sessionId));
    if (stored === 'true') return true;
    if (stored === 'false') return false;
    return null;
  } catch {
    return null;
  }
}

export function rememberHeaderChoice(sessionId: string, open: boolean): void {
  try {
    localStorage.setItem(storageKeyOf(sessionId), String(open));
  } catch {
    // Storage is unavailable: the header still toggles, it just is not remembered.
  }
}
