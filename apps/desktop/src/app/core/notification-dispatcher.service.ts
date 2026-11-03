import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MANAGER_ROLE, type NotificationTrigger, type Session } from '@openfleet/shared';
import { FleetApiService } from './fleet-api.service';
import { FleetEventsService } from './fleet-events.service';
import { NativeNotifications, type NativeNotification } from './native-notifications.service';
import { NotificationPrefsStore } from './notification-prefs.store';

const BURST_WINDOW_MS = 500;
const TOOL_COMPLETION_WINDOW_MS = 15_000;
const INBOX_ROUTE = '/inbox';
const MAX_REMEMBERED_PROMPTS = 500;

const TRIGGER_BANNER_TITLE = 'Trigger fired';
const TRIGGER_BANNER_FALLBACK_BODY = 'A trigger fired';
const MAX_TRIGGER_BANNER_BODY_CHARS = 80;
const CONTROL_OR_FORMAT_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

/** The title of a trigger as a banner body: one line, no control characters, at most 80 characters. */
const triggerBannerBodyOf = (title: string | undefined): string => {
  const oneLine = (title ?? '').replace(CONTROL_OR_FORMAT_CHARACTERS, ' ').trim();
  if (oneLine === '') return TRIGGER_BANNER_FALLBACK_BODY;
  const characters = Array.from(oneLine);
  return characters.length <= MAX_TRIGGER_BANNER_BODY_CHARS ? oneLine : `${characters.slice(0, MAX_TRIGGER_BANNER_BODY_CHARS).join('')}…`;
};

/** The notifications that are about a session; a trigger notice is about a trigger and is announced on its own. */
type SessionNotification = Exclude<NotificationTrigger, { category: 'triggerNotice' }>;
type TriggerNotice = Extract<NotificationTrigger, { category: 'triggerNotice' }>;
const KNOWN_CATEGORIES = ['agentFinished', 'needsInput', 'toolCompletion', 'chatMessage'] as const satisfies readonly NotificationTrigger['category'][];
type TriggerCategory = SessionNotification['category'];

const isKnownCategory = (category: string): category is TriggerCategory => (KNOWN_CATEGORIES as readonly string[]).includes(category);

const PREF_OF_CATEGORY: Record<TriggerCategory, TriggerCategory> = {
  agentFinished: 'agentFinished',
  needsInput: 'needsInput',
  toolCompletion: 'toolCompletion',
  chatMessage: 'chatMessage',
};

const BURST_SUMMARY_OF_CATEGORY: Record<TriggerCategory, (count: number) => string> = {
  agentFinished: (count) => `${count} sessions finished`,
  needsInput: (count) => `${count} sessions need you`,
  toolCompletion: (count) => `${count} sessions ran tools`,
  chatMessage: (count) => `${count} sessions asked you questions`,
};

const sessionRouteOf = (session: Session | undefined, sessionId: string): string =>
  session?.role === MANAGER_ROLE ? `/manager/${sessionId}` : `/session/${sessionId}`;

function bodyOf(trigger: SessionNotification): string {
  if (trigger.category === 'agentFinished') return 'Finished';
  if (trigger.category === 'chatMessage') return trigger.questionCount === 1 ? 'Asked you a question' : `Asked you ${trigger.questionCount} questions`;
  if (trigger.category === 'toolCompletion') return `${trigger.toolName} finished`;
  return trigger.kind === 'permission' ? 'Waiting for permission' : 'Waiting for your input';
}

/** Turns the daemon's notification triggers into system banners, honouring the preferences, the foreground session and bursts. */
@Injectable({ providedIn: 'root' })
export class NotificationDispatcher {
  private readonly events = inject(FleetEventsService);
  private readonly notifications = inject(NativeNotifications);
  private readonly prefs = inject(NotificationPrefsStore);
  private readonly router = inject(Router);
  private readonly api = inject(FleetApiService);
  private readonly refusedByTheSystem = signal(false);
  private readonly pendingByCategory = new Map<TriggerCategory, SessionNotification[]>();
  private readonly announcedFireIds = new Set<string>();
  private readonly announcedPromptKeys = new Set<string>();

  /** True once the system refused to show banners for this app. */
  readonly isPermissionDenied = this.refusedByTheSystem.asReadonly();

  constructor() {
    this.events.notificationTriggers.subscribe((trigger) => this.receive(trigger));
  }

  private receive(trigger: NotificationTrigger): void {
    if (trigger.category === 'triggerNotice') return void this.announceTriggerNotice(trigger);
    if (!isKnownCategory(trigger.category)) return;
    if (this.isSilenced(trigger)) return;
    if (this.isAlreadyAnnounced(trigger)) return;
    if (trigger.category === 'chatMessage') {
      void this.show(this.bannerOf(trigger));
      return;
    }
    const burst = this.pendingByCategory.get(trigger.category);
    if (burst) {
      burst.push(trigger);
      return;
    }
    this.pendingByCategory.set(trigger.category, [trigger]);
    const windowMs = trigger.category === 'toolCompletion' ? TOOL_COMPLETION_WINDOW_MS : BURST_WINDOW_MS;
    setTimeout(() => this.flush(trigger.category), windowMs);
  }

  /** The banner is fixed: only the title of the trigger, read from the admin API and never from the event, fills its body. */
  private async announceTriggerNotice({ triggerId, fireId }: TriggerNotice): Promise<void> {
    const { enabled, muted } = this.prefs.prefs();
    if (!enabled || muted || this.hasAnnouncedFire(fireId)) return;
    const title = await this.api.getTrigger(triggerId).then((trigger) => trigger.title, () => undefined);
    await this.show({ title: TRIGGER_BANNER_TITLE, body: triggerBannerBodyOf(title), route: INBOX_ROUTE });
  }

  private hasAnnouncedFire(fireId: string): boolean {
    if (this.announcedFireIds.has(fireId)) return true;
    if (this.announcedFireIds.size >= MAX_REMEMBERED_PROMPTS) this.announcedFireIds.clear();
    this.announcedFireIds.add(fireId);
    return false;
  }

  private isSilenced(trigger: SessionNotification): boolean {
    const choices = this.prefs.prefs();
    const { enabled, muted } = choices;
    const isCategoryOn = choices[PREF_OF_CATEGORY[trigger.category]];
    const isAppInFrontOnThatSession = document.hasFocus() && this.router.url === this.routeOf(trigger.sessionId);
    return !enabled || muted || !isCategoryOn || isAppInFrontOnThatSession;
  }

  private isAlreadyAnnounced(trigger: SessionNotification): boolean {
    if (trigger.category !== 'needsInput' && trigger.category !== 'chatMessage') return false;
    const eventKey = trigger.category === 'needsInput' ? trigger.promptKey : trigger.questionKey;
    const promptKey = `${trigger.category}@${trigger.sessionId}@${eventKey}`;
    if (this.announcedPromptKeys.has(promptKey)) return true;
    if (this.announcedPromptKeys.size >= MAX_REMEMBERED_PROMPTS) this.announcedPromptKeys.clear();
    this.announcedPromptKeys.add(promptKey);
    return false;
  }

  private flush(category: TriggerCategory): void {
    const pending = this.pendingByCategory.get(category) ?? [];
    this.pendingByCategory.delete(category);
    const burst = pending.filter((trigger) => !this.isSilenced(trigger));
    const sessionIds = new Set(burst.map((trigger) => trigger.sessionId));
    const [first] = burst;
    if (!first) return;
    const isSingleSession = sessionIds.size === 1;
    const banner = isSingleSession ? this.bannerOf(first, { toolCount: burst.length }) : this.summaryBannerOf(category, sessionIds.size);
    void this.show(banner);
  }

  private bannerOf(trigger: SessionNotification, { toolCount = 1 }: { toolCount?: number } = {}): NativeNotification {
    const session = this.sessionOf(trigger.sessionId);
    const title = session ? `${session.emoji} ${session.name}` : 'OpenFleet';
    const hasMultipleTools = trigger.category === 'toolCompletion' && toolCount > 1;
    const body = hasMultipleTools ? `${toolCount} tools finished` : bodyOf(trigger);
    return { title, body, route: this.routeOf(trigger.sessionId) };
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
