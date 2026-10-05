const STORAGE_KEY_PREFIX = 'openfleet.sidebar.group.';
const OPEN = '1';
const COLLAPSED = '0';

const storageKeyOf = (groupKey: string) => `${STORAGE_KEY_PREFIX}${groupKey}.open`;

/** Returns whether the group is open; a group never toggled, or an unavailable storage, falls back to open. */
export function readGroupOpenPreference(groupKey: string): boolean {
  try {
    return localStorage.getItem(storageKeyOf(groupKey)) !== COLLAPSED;
  } catch {
    return true;
  }
}

export function writeGroupOpenPreference(groupKey: string, isOpen: boolean): void {
  try {
    localStorage.setItem(storageKeyOf(groupKey), isOpen ? OPEN : COLLAPSED);
  } catch {
    // The preference is a convenience; an unavailable storage only loses persistence.
  }
}
