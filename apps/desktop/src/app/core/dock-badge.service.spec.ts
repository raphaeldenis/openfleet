import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Approval } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentWorkingStateSignals, sessionOf } from '../working-state/working-state-fixtures';
import { DockBadgeService } from './dock-badge.service';
import { FleetEventsService } from './fleet-events.service';
import { NativeNotifications } from './native-notifications.service';
import { NotificationPrefsStore } from './notification-prefs.store';

const STORAGE_KEY = 'openfleet.notifications.v1';
const approval = (id: string) => ({ id, sessionId: 's1' }) as unknown as Approval;

function startDockBadge(prefs: object = {}) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  const approvals = signal<Approval[]>([approval('a1'), approval('a2')]);
  const badgeCounts: number[] = [];
  const notifications = {
    isAvailable: true,
    setDockBadge: vi.fn(async (count: number) => void badgeCounts.push(count)),
    onBannerClick: vi.fn(async () => () => undefined),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: NativeNotifications, useValue: notifications },
      { provide: FleetEventsService, useValue: { sessions: signal([sessionOf()]), approvals, ...silentWorkingStateSignals() } },
    ],
  });
  TestBed.inject(DockBadgeService);
  TestBed.tick();
  return { approvals, badgeCounts };
}

describe('DockBadgeService', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('shows the number the sidebar Inbox badge shows', () => {
    const { badgeCounts } = startDockBadge();

    expect(badgeCounts.at(-1)).toBe(2);
  });

  it('follows the Inbox when an item is decided', () => {
    const { approvals, badgeCounts } = startDockBadge();

    approvals.set([approval('a1')]);
    TestBed.tick();

    expect(badgeCounts.at(-1)).toBe(1);
  });

  it('clears the Dock when the Dock badge is switched off, and brings the number back when it is switched on again', () => {
    const { badgeCounts } = startDockBadge({ dockBadge: false });
    expect(badgeCounts.at(-1)).toBe(0);

    TestBed.inject(NotificationPrefsStore).set('dockBadge', true);
    TestBed.tick();

    expect(badgeCounts.at(-1)).toBe(2);
  });
});
