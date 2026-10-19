import { Injectable, effect, inject } from '@angular/core';
import { NativeNotifications } from '../core/native-notifications.service';
import { NotificationPrefsStore } from '../core/notification-prefs.store';
import { InboxNeedingYou } from './inbox-needing-you';

/** Mirrors the sidebar Inbox count on the Dock tile; the count is zero while the Dock badge is switched off. */
@Injectable({ providedIn: 'root' })
export class DockBadgeService {
  constructor() {
    const notifications = inject(NativeNotifications);
    const inbox = inject(InboxNeedingYou);
    const prefs = inject(NotificationPrefsStore);
    effect(() => {
      const count = prefs.prefs().dockBadge ? inbox.count() : 0;
      void notifications.setDockBadge(count);
    });
  }
}
