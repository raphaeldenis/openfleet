import { Injectable } from '@angular/core';

export type SaveBundleOutcome = { status: 'saved'; path: string } | { status: 'cancelled' };

/** A daemon ring buffer record as the desktop log would write it: every value passed the typed field registry. */
export interface ProjectedDaemonRecord {
  ts: string;
  level: string;
  event: string;
  fields: Record<string, string>;
}

/** What the desktop shell offers to export diagnostics: the desktop log, the projection of the daemon's records, the native save dialog and a reveal of the saved file. */
@Injectable({ providedIn: 'root', useFactory: () => new TauriDiagnosticsExport() })
export abstract class DiagnosticsExport {
  abstract readonly isAvailable: boolean;
  /** The tail of `desktop.log` as written: allowlisted typed records, where free text appears only as `[text:<length>:<tag>]`. */
  abstract readDesktopLog(): Promise<string>;
  /** Projects each record of the daemon's ring buffer onto the desktop log's allowlist; the free text never comes back. */
  abstract projectDaemonRecords(records: unknown[]): Promise<ProjectedDaemonRecord[]>;
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

  async projectDaemonRecords(records: unknown[]): Promise<ProjectedDaemonRecord[]> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<ProjectedDaemonRecord[]>('project_daemon_records', { records });
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
