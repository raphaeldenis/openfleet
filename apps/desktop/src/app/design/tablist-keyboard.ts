export type TabListOrientation = 'horizontal' | 'vertical';

interface TabKeyContext {
  readonly currentIndex: number;
  readonly tabCount: number;
  readonly orientation: TabListOrientation;
}

const STEP_KEYS: Record<TabListOrientation, { previous: string; next: string }> = {
  horizontal: { previous: 'ArrowLeft', next: 'ArrowRight' },
  vertical: { previous: 'ArrowUp', next: 'ArrowDown' },
};

/** Returns the index of the tab a key press moves to, or undefined when the key is left to the browser. */
export function nextTabIndex(event: KeyboardEvent, { currentIndex, tabCount, orientation }: TabKeyContext): number | undefined {
  const hasModifierKey = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
  if (hasModifierKey) return undefined;

  const { previous, next } = STEP_KEYS[orientation];
  switch (event.key) {
    case next: return (currentIndex + 1) % tabCount;
    case previous: return (currentIndex - 1 + tabCount) % tabCount;
    case 'Home': return 0;
    case 'End': return tabCount - 1;
    default: return undefined;
  }
}

/** Moves DOM focus to the tab button at the given index inside the tab list. */
export function focusTabAt(tabList: HTMLElement, tabIndex: number): void {
  tabList.querySelectorAll<HTMLElement>('[role="tab"]')[tabIndex].focus();
}
