import { Injectable, effect, inject } from '@angular/core';
import { InboxNeedingYou } from '../inbox/inbox-needing-you';
import { NativeNotifications } from './native-notifications.service';
import { NotificationPrefsStore } from './notification-prefs.store';

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
