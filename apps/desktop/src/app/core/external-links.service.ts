import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ExternalLinks {
  open(url: string, event: MouseEvent): void {
    const protocol = new URL(url).protocol;
    const isWebUrl = protocol === 'http:' || protocol === 'https:';
    if (!isWebUrl) return;
    const isDesktop = '__TAURI_INTERNALS__' in globalThis;
    if (!isDesktop) return;
    event.preventDefault();
    void this.openInDesktop(url);
  }

  private async openInDesktop(url: string): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_external_url', { url });
  }
}
