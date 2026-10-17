import { Injectable } from '@angular/core';

export type NativeNotificationOutcome = 'delivered' | 'permissionDenied' | 'unsupported';

export interface NativeNotification {
  title: string;
  body: string;
  /** An in-app path such as `/session/abc`, opened when the banner is clicked. */
  route: string;
}

type Unlisten = () => void;

const CLICK_EVENT_NAME = 'native-notification-clicked';

/** What the desktop shell offers for system banners and the Dock tile; every call is a no-op outside the desktop app. */
@Injectable({ providedIn: 'root', useFactory: () => new TauriNativeNotifications() })
export abstract class NativeNotifications {
  abstract readonly isAvailable: boolean;
  /** Raises a system banner; a permission the human refused answers `permissionDenied` instead of throwing. */
  abstract show(notification: NativeNotification): Promise<NativeNotificationOutcome>;
  /** Shows `count` on the Dock tile; zero clears it. */
  abstract setDockBadge(count: number): Promise<void>;
  /** Calls `handler` with the route of every clicked banner; the returned function stops listening. */
  abstract onBannerClick(handler: (route: string) => void): Promise<Unlisten>;
}

class TauriNativeNotifications extends NativeNotifications {
  readonly isAvailable = '__TAURI_INTERNALS__' in globalThis;

  async show(notification: NativeNotification): Promise<NativeNotificationOutcome> {
    if (!this.isAvailable) return 'unsupported';
    const { invoke } = await import('@tauri-apps/api/core');
    const { status } = await invoke<{ status: NativeNotificationOutcome }>('show_native_notification', { request: notification });
    return status;
  }

  async setDockBadge(count: number): Promise<void> {
    if (!this.isAvailable) return;
    const { invoke } = await import('@tauri-apps/api/core');
    const wholeCount = Math.max(0, Math.trunc(count));
    await invoke('set_dock_badge', { count: wholeCount });
  }

  async onBannerClick(handler: (route: string) => void): Promise<Unlisten> {
    if (!this.isAvailable) return () => undefined;
    const { listen } = await import('@tauri-apps/api/event');
    return listen<{ route: string }>(CLICK_EVENT_NAME, (event) => handler(event.payload.route));
  }
}
