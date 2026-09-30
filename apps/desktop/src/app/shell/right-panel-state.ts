import { Injectable, signal } from '@angular/core';

const OPEN_STORAGE_KEY = 'openfleet.rightPanel.open';

function readRememberedOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_STORAGE_KEY) === 'true';
  } catch {
    return false;
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
  /** The top-bar toggle registers itself here so Escape and Collapse can hand focus back to it. */
  toggleButton: HTMLElement | null = null;

  toggle(): void {
    this.setOpen(!this.open());
  }

  close(): void {
    this.setOpen(false);
  }

  focusToggle(): void {
    this.toggleButton?.focus();
  }

  private setOpen(open: boolean): void {
    this.open.set(open);
    rememberOpen(open);
  }
}
