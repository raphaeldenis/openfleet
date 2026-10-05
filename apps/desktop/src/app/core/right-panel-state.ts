import { Injectable, signal } from '@angular/core';

export const RIGHT_PANEL_SHOW_TITLE = 'Show the right panel (⌥⌘B)';
export const RIGHT_PANEL_HIDE_TITLE = 'Hide the right panel (⌥⌘B)';

const OPEN_STORAGE_KEY = 'openfleet.rightPanel.open';

/** The panel holds the identity and actions of the selected session, so a user who never chose sees it open. */
function readRememberedOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

function rememberOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_STORAGE_KEY, String(open));
  } catch {
    // Storage is unavailable: the panel still works, it just is not remembered.
  }
}

@Injectable({ providedIn: 'root' })
export class RightPanelState {
  readonly open = signal(readRememberedOpen());
  /** The tab the user picked; it outlives the panel, which only exists while a session or manager is selected. */
  readonly chosenTabKey = signal<string | undefined>(undefined);

  toggle(): void {
    this.setOpen(!this.open());
  }

  close(): void {
    this.setOpen(false);
  }

  private setOpen(open: boolean): void {
    this.open.set(open);
    rememberOpen(open);
  }
}
