import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import type { NotificationTrigger, Session } from '@openfleet/shared';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionOf, silentWorkingStateSignals } from '../working-state/working-state-fixtures';
import { FleetEventsService } from './fleet-events.service';
import { NativeNotifications, type NativeNotificationOutcome } from './native-notifications.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import type { NotificationPrefs } from './notification-prefs.store';

const STORAGE_KEY = 'openfleet.notifications.v1';
const BURST_WINDOW_MS = 1_000;

interface Setup {
  sessions?: Session[];
  prefs?: Partial<NotificationPrefs>;
  currentUrl?: string;
  isAppFocused?: boolean;
  outcome?: NativeNotificationOutcome;
}

function startDispatcher({ sessions = [sessionOf()], prefs = {}, currentUrl = '/inbox', isAppFocused = false, outcome = 'delivered' }: Setup = {}) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  vi.spyOn(document, 'hasFocus').mockReturnValue(isAppFocused);
  const triggers = new Subject<NotificationTrigger>();
  const shown: { title: string; body: string; route: string }[] = [];
  const notifications = {
    isAvailable: true,
    show: vi.fn(async (banner: { title: string; body: string; route: string }) => {
      shown.push(banner);
      return outcome;
    }),
    setDockBadge: vi.fn(async () => undefined),
    onBannerClick: vi.fn(async () => () => undefined),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: NativeNotifications, useValue: notifications },
      { provide: Router, useValue: { url: currentUrl } },
      { provide: FleetEventsService, useValue: { notificationTriggers: triggers, sessions: signal(sessions), approvals: signal([]), ...silentWorkingStateSignals() } },
    ],
  });
  const dispatcher = TestBed.inject(NotificationDispatcher);
  const raise = async (...burst: NotificationTrigger[]) => {
    burst.forEach((trigger) => triggers.next(trigger));
    await vi.advanceTimersByTimeAsync(BURST_WINDOW_MS);
  };
  return { dispatcher, shown, raise };
}

const finished = (sessionId = 's1'): NotificationTrigger => ({ category: 'agentFinished', sessionId });
const needsInput = (sessionId = 's1', promptKey = 'p1', kind: 'permission' | 'input' = 'permission'): NotificationTrigger => ({ category: 'needsInput', sessionId, kind, promptKey, toolName: 'Bash' });

describe('NotificationDispatcher', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('raises a banner named after the session when it waits for a permission, without saying which tool', async () => {
    const { shown, raise } = startDispatcher();

    await raise(needsInput());

    expect(shown).toEqual([{ title: '⚔️ Gimli', body: 'Waiting for permission', route: '/session/s1' }]);
  });

  it('raises a banner saying the session waits for input', async () => {
    const { shown, raise } = startDispatcher();

    await raise(needsInput('s1', 'p1', 'input'));

    expect(shown[0]).toMatchObject({ body: 'Waiting for your input' });
  });

  it('raises a banner when an agent finished', async () => {
    const { shown, raise } = startDispatcher();

    await raise(finished());

    expect(shown).toEqual([{ title: '⚔️ Gimli', body: 'Finished', route: '/session/s1' }]);
  });

  it('opens a manager session on the manager screen', async () => {
    const { shown, raise } = startDispatcher({ sessions: [sessionOf({ id: 'm1', name: 'Capitaine', role: 'manager' })] });

    await raise(finished('m1'));

    expect(shown[0]?.route).toBe('/manager/m1');
  });

  it('stays silent when notifications are switched off', async () => {
    const { shown, raise } = startDispatcher({ prefs: { enabled: false } });

    await raise(finished());
    await raise(needsInput());

    expect(shown).toEqual([]);
  });

  it('stays silent while muted', async () => {
    const { shown, raise } = startDispatcher({ prefs: { muted: true } });

    await raise(needsInput());

    expect(shown).toEqual([]);
  });

  it('silences only the category that is switched off', async () => {
    const { shown, raise } = startDispatcher({ prefs: { agentFinished: false } });

    await raise(finished());
    await raise(needsInput());

    expect(shown.map((banner) => banner.body)).toEqual(['Waiting for permission']);
  });

  it('raises no banner when the app is in front on the route of that session', async () => {
    const { shown, raise } = startDispatcher({ isAppFocused: true, currentUrl: '/session/s1' });

    await raise(needsInput());

    expect(shown).toEqual([]);
  });

  it('raises a banner when the app is in front on another route', async () => {
    const { shown, raise } = startDispatcher({ isAppFocused: true, currentUrl: '/session/other' });

    await raise(needsInput());

    expect(shown).toHaveLength(1);
  });

  it('raises a banner when the session route is open but the app is in the background', async () => {
    const { shown, raise } = startDispatcher({ isAppFocused: false, currentUrl: '/session/s1' });

    await raise(needsInput());

    expect(shown).toHaveLength(1);
  });

  it('raises one banner for the same prompt however many times it is reported', async () => {
    const { shown, raise } = startDispatcher();

    await raise(needsInput('s1', 'p1'));
    await raise(needsInput('s1', 'p1'));
    await raise(needsInput('s1', 'p2'));

    expect(shown).toHaveLength(2);
  });

  it('folds three finished agents reported together into a single banner that opens the Inbox', async () => {
    const sessions = [sessionOf({ id: 'a' }), sessionOf({ id: 'b' }), sessionOf({ id: 'c' })];
    const { shown, raise } = startDispatcher({ sessions });

    await raise(finished('a'), finished('b'), finished('c'));

    expect(shown).toEqual([{ title: 'OpenFleet', body: '3 sessions finished', route: '/inbox' }]);
  });

  it('folds a burst of sessions waiting for the human into one banner that opens the Inbox', async () => {
    const sessions = [sessionOf({ id: 'a' }), sessionOf({ id: 'b' })];
    const { shown, raise } = startDispatcher({ sessions });

    await raise(needsInput('a'), needsInput('b'));

    expect(shown).toEqual([{ title: 'OpenFleet', body: '2 sessions need you', route: '/inbox' }]);
  });

  it('remembers a refused system permission so Settings can say so', async () => {
    const { dispatcher, raise } = startDispatcher({ outcome: 'permissionDenied' });

    await raise(finished());

    expect(dispatcher.isPermissionDenied()).toBe(true);
  });
});
