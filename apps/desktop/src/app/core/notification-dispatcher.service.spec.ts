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
import { NotificationPrefsStore, type NotificationPrefs } from './notification-prefs.store';

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
const toolFinished = (sessionId = 's1', toolName = 'Bash'): NotificationTrigger => ({ category: 'toolCompletion', sessionId, toolUseId: `${sessionId}-${toolName}`, toolName });
const questionAsked = (sessionId = 's1', questionKey = 'q1'): NotificationTrigger => ({ category: 'chatMessage', sessionId, questionKey, questionCount: 1 });

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

  it('waits fifteen seconds before announcing a completed tool', async () => {
    const { shown, raise } = startDispatcher({ prefs: { toolCompletion: true } });

    await raise(toolFinished());
    expect(shown).toEqual([]);
    await vi.advanceTimersByTimeAsync(13_999);
    expect(shown).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(shown).toEqual([{ title: '⚔️ Gimli', body: 'Bash finished', route: '/session/s1' }]);
  });

  it('keeps tool completion silent by default', async () => {
    const { shown, raise } = startDispatcher();

    await raise(toolFinished());
    await vi.advanceTimersByTimeAsync(15_000);

    expect(shown).toEqual([]);
  });

  it.each([
    { enabled: false, toolCompletion: true },
    { muted: true, toolCompletion: true },
    { toolCompletion: false, chatMessage: false },
  ])('silences both new categories with preferences %j', async (prefs) => {
    const { shown, raise } = startDispatcher({ prefs });

    await raise(toolFinished(), questionAsked());
    await vi.advanceTimersByTimeAsync(15_000);

    expect(shown).toEqual([]);
  });

  it('silences both new categories on the foreground session', async () => {
    const { shown, raise } = startDispatcher({ prefs: { toolCompletion: true }, isAppFocused: true, currentUrl: '/session/s1' });

    await raise(toolFinished(), questionAsked());
    await vi.advanceTimersByTimeAsync(15_000);

    expect(shown).toEqual([]);
  });

  it('drops queued tools when the human mutes notifications during the window', async () => {
    const { shown, raise } = startDispatcher({ prefs: { toolCompletion: true } });
    await raise(toolFinished());

    TestBed.inject(NotificationPrefsStore).set('muted', true);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(shown).toEqual([]);
  });

  it('opens manager questions and tool banners on the manager screen', async () => {
    const { shown, raise } = startDispatcher({ prefs: { toolCompletion: true }, sessions: [sessionOf({ id: 'm1', role: 'manager' })] });

    await raise(questionAsked('m1'), toolFinished('m1'));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(shown.map((banner) => banner.route)).toEqual(['/manager/m1', '/manager/m1']);
  });

  it('ignores a category from a newer daemon and continues showing known banners', async () => {
    const { shown, raise } = startDispatcher();

    await raise({ category: 'futureCategory', sessionId: 's1' } as unknown as NotificationTrigger);
    await raise(questionAsked());

    expect(shown.map((banner) => banner.body)).toEqual(['Asked you a question']);
  });

  it('shows separate banners for distinct question updates received together', async () => {
    const { shown, raise } = startDispatcher();

    await raise(questionAsked('s1', 'q1'), questionAsked('s1', 'q2'), questionAsked('s1', 'q1'));

    expect(shown).toHaveLength(2);
  });

  it('counts tools in one session at the end of each fifteen-second window', async () => {
    const { shown, raise } = startDispatcher({ prefs: { toolCompletion: true } });

    await raise(toolFinished());
    await vi.advanceTimersByTimeAsync(10_000);
    await raise(toolFinished('s1', 'Read'));
    await vi.advanceTimersByTimeAsync(3_000);

    expect(shown).toEqual([{ title: '⚔️ Gimli', body: '2 tools finished', route: '/session/s1' }]);
    await raise(toolFinished('s1', 'Edit'));
    await vi.advanceTimersByTimeAsync(14_000);
    expect(shown[1]?.body).toBe('Edit finished');
  });

  it('summarizes sessions running tools into an Inbox banner', async () => {
    const { shown, raise } = startDispatcher({ prefs: { toolCompletion: true } });

    await raise(toolFinished(), toolFinished('other', 'Read'), toolFinished('other', 'Edit'));
    await vi.advanceTimersByTimeAsync(14_000);

    expect(shown).toEqual([{ title: 'OpenFleet', body: '2 sessions ran tools', route: '/inbox' }]);
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

  it('announces each question update once without question text', async () => {
    const { shown, raise } = startDispatcher();
    const question: NotificationTrigger = { category: 'chatMessage', sessionId: 's1', questionKey: 'q1', questionCount: 1 };

    await raise(question);
    await raise(question);
    await raise({ ...question, questionKey: 'q2', questionCount: 3 });

    expect(shown).toEqual([
      { title: '⚔️ Gimli', body: 'Asked you a question', route: '/session/s1' },
      { title: '⚔️ Gimli', body: 'Asked you 3 questions', route: '/session/s1' },
    ]);
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
