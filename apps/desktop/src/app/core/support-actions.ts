import { Injectable } from '@angular/core';

/** What the desktop shell offers for support: showing the daemon logs and opening a prefilled bug report in the browser. */
@Injectable({ providedIn: 'root', useFactory: () => new TauriSupportActions() })
export abstract class SupportActions {
  abstract readonly isAvailable: boolean;
  /** Reveals the daemon logs folder in the file manager. */
  abstract revealLogs(): Promise<void>;
  /** Opens the prefilled issue form in the default browser; nothing is sent until the user submits it there. */
  abstract reportIssue(): Promise<void>;
}

class TauriSupportActions extends SupportActions {
  readonly isAvailable = '__TAURI_INTERNALS__' in globalThis;

  async revealLogs(): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('reveal_logs');
  }

  async reportIssue(): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('report_issue');
  }
}
