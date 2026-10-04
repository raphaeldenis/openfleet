import { Injectable } from '@angular/core';

export type SaveBundleOutcome = { status: 'saved'; path: string } | { status: 'cancelled' };

/** What the desktop shell offers to export diagnostics: the desktop log, the native save dialog and a reveal of the saved file. */
@Injectable({ providedIn: 'root', useFactory: () => new TauriDiagnosticsExport() })
export abstract class DiagnosticsExport {
  abstract readonly isAvailable: boolean;
  /** The tail of the desktop's daemon log, secrets masked and the home folder shortened. */
  abstract readDesktopLog(): Promise<string>;
  /** Shows the native save dialog and writes the zip where the user chooses; a dismissed dialog answers `cancelled`. */
  abstract saveBundle(bundle: { fileName: string; bytes: Uint8Array }): Promise<SaveBundleOutcome>;
  /** Shows the last saved bundle in the file manager. */
  abstract revealSavedBundle(): Promise<void>;
}

const DEFAULT_NAME_HEADER = 'x-default-name';

class TauriDiagnosticsExport extends DiagnosticsExport {
  readonly isAvailable = '__TAURI_INTERNALS__' in globalThis;

  async readDesktopLog(): Promise<string> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('read_desktop_log');
  }

  async saveBundle({ fileName, bytes }: { fileName: string; bytes: Uint8Array }): Promise<SaveBundleOutcome> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<SaveBundleOutcome>('save_diagnostics_bundle', bytes, { headers: { [DEFAULT_NAME_HEADER]: fileName } });
  }

  async revealSavedBundle(): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('reveal_diagnostics_bundle');
  }
}
