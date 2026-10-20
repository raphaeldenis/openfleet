import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MANAGER_ROLE, type NotificationTrigger, type Session } from '@openfleet/shared';
import { FleetEventsService } from './fleet-events.service';
import { NativeNotifications, type NativeNotification } from './native-notifications.service';
import { NotificationPrefsStore } from './notification-prefs.store';

const BURST_WINDOW_MS = 500;
const INBOX_ROUTE = '/inbox';
const MAX_REMEMBERED_PROMPTS = 500;

const SHOWN_CATEGORIES = ['agentFinished', 'needsInput'] as const;
type TriggerCategory = (typeof SHOWN_CATEGORIES)[number];
type ShownTrigger = Extract<NotificationTrigger, { category: TriggerCategory }>;

const isShown = (trigger: NotificationTrigger): trigger is ShownTrigger => (SHOWN_CATEGORIES as readonly string[]).includes(trigger.category);

const PREF_OF_CATEGORY: Record<TriggerCategory, 'agentFinished' | 'needsInput'> = {
  agentFinished: 'agentFinished',
  needsInput: 'needsInput',
};

const BURST_SUMMARY_OF_CATEGORY: Record<TriggerCategory, (count: number) => string> = {
  agentFinished: (count) => `${count} sessions finished`,
  needsInput: (count) => `${count} sessions need you`,
};

const sessionRouteOf = (session: Session | undefined, sessionId: string): string =>
  session?.role === MANAGER_ROLE ? `/manager/${sessionId}` : `/session/${sessionId}`;

function bodyOf(trigger: ShownTrigger): string {
  if (trigger.category === 'agentFinished') return 'Finished';
  return trigger.kind === 'permission' ? 'Waiting for permission' : 'Waiting for your input';
}

/** Turns the daemon's notification triggers into system banners, honouring the preferences, the foreground session and bursts. */
@Injectable({ providedIn: 'root' })
export class NotificationDispatcher {
  private readonly events = inject(FleetEventsService);
  private readonly notifications = inject(NativeNotifications);
  private readonly prefs = inject(NotificationPrefsStore);
  private readonly router = inject(Router);
  private readonly refusedByTheSystem = signal(false);
  private readonly pendingByCategory = new Map<TriggerCategory, ShownTrigger[]>();
  private readonly announcedPromptKeys = new Set<string>();

  /** True once the system refused to show banners for this app. */
  readonly isPermissionDenied = this.refusedByTheSystem.asReadonly();

  constructor() {
    this.events.notificationTriggers.subscribe((trigger) => this.receive(trigger));
  }

  private receive(trigger: NotificationTrigger): void {
    if (!isShown(trigger)) return;
    if (this.isSilenced(trigger)) return;
    if (this.isAlreadyAnnounced(trigger)) return;
    const burst = this.pendingByCategory.get(trigger.category);
    if (burst) {
      burst.push(trigger);
      return;
    }
    this.pendingByCategory.set(trigger.category, [trigger]);
    setTimeout(() => this.flush(trigger.category), BURST_WINDOW_MS);
  }

  private isSilenced(trigger: ShownTrigger): boolean {
    const choices = this.prefs.prefs();
    const { enabled, muted } = choices;
    const isCategoryOn = choices[PREF_OF_CATEGORY[trigger.category]];
    const isAppInFrontOnThatSession = document.hasFocus() && this.router.url === this.routeOf(trigger.sessionId);
    return !enabled || muted || !isCategoryOn || isAppInFrontOnThatSession;
  }

  private isAlreadyAnnounced(trigger: ShownTrigger): boolean {
    if (trigger.category !== 'needsInput') return false;
    const promptKey = `${trigger.sessionId}@${trigger.promptKey}`;
    if (this.announcedPromptKeys.has(promptKey)) return true;
    if (this.announcedPromptKeys.size >= MAX_REMEMBERED_PROMPTS) this.announcedPromptKeys.clear();
    this.announcedPromptKeys.add(promptKey);
    return false;
  }

  private flush(category: TriggerCategory): void {
    const burst = this.pendingByCategory.get(category) ?? [];
    this.pendingByCategory.delete(category);
    const sessionIds = new Set(burst.map((trigger) => trigger.sessionId));
    const [first] = burst;
    if (!first) return;
    const isSingleSession = sessionIds.size === 1;
    const banner = isSingleSession ? this.bannerOf(first) : this.summaryBannerOf(category, sessionIds.size);
    void this.show(banner);
  }

  private bannerOf(trigger: ShownTrigger): NativeNotification {
    const session = this.sessionOf(trigger.sessionId);
    const title = session ? `${session.emoji} ${session.name}` : 'OpenFleet';
    return { title, body: bodyOf(trigger), route: this.routeOf(trigger.sessionId) };
  }

  private summaryBannerOf(category: TriggerCategory, sessionCount: number): NativeNotification {
    return { title: 'OpenFleet', body: BURST_SUMMARY_OF_CATEGORY[category](sessionCount), route: INBOX_ROUTE };
  }

  private async show(banner: NativeNotification): Promise<void> {
    const outcome = await this.notifications.show(banner).catch(() => 'unsupported' as const);
    if (outcome === 'permissionDenied') this.refusedByTheSystem.set(true);
    if (outcome === 'delivered') this.refusedByTheSystem.set(false);
  }

  private sessionOf(sessionId: string): Session | undefined {
    return this.events.sessions().find((session) => session.id === sessionId);
  }

  private routeOf(sessionId: string): string {
    return sessionRouteOf(this.sessionOf(sessionId), sessionId);
  }
}
