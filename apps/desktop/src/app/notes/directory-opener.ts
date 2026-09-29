import { Injectable } from '@angular/core';

/** Reveals a folder in the operating system's file manager. */
@Injectable({ providedIn: 'root', useFactory: () => new TauriDirectoryOpener() })
export abstract class DirectoryOpener {
  abstract readonly isAvailable: boolean;
  abstract open(path: string): Promise<void>;
}

// ponytail: stays false until backlog row OPENER01 registers tauri-plugin-opener and its capability;
// flip it there, the button appears with no other change.
const OPENER_PLUGIN_REGISTERED = false;

class TauriDirectoryOpener extends DirectoryOpener {
  readonly isAvailable = OPENER_PLUGIN_REGISTERED && '__TAURI_INTERNALS__' in globalThis;

  async open(path: string): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('plugin:opener|open_path', { path });
  }
}
