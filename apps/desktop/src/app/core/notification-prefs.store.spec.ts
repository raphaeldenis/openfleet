import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationPrefsStore } from './notification-prefs.store';

const STORAGE_KEY = 'openfleet.notifications.v1';

function openStore(): NotificationPrefsStore {
  TestBed.resetTestingModule();
  return TestBed.inject(NotificationPrefsStore);
}

describe('NotificationPrefsStore', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('starts with banners for finished agents, needed input and chat on, tool completion, sound and mute off, Dock badge on', () => {
    const store = openStore();

    expect(store.prefs()).toEqual({
      enabled: true,
      agentFinished: true,
      toolCompletion: false,
      needsInput: true,
      chatMessage: true,
      sound: false,
      visual: true,
      muted: false,
      dockBadge: true,
    });
  });

  it('remembers a changed preference after a reload', () => {
    openStore().set('muted', true);

    const afterReload = openStore();

    expect(afterReload.prefs().muted).toBe(true);
    expect(afterReload.prefs().enabled).toBe(true);
  });

  it('keeps defaults for what a stored value gets wrong', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: 'yes', needsInput: false, unknown: 1 }));

    const store = openStore();

    expect(store.prefs().enabled).toBe(true);
    expect(store.prefs().needsInput).toBe(false);
  });

  it('starts with defaults when the stored value is not JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{nope');

    expect(openStore().prefs().enabled).toBe(true);
  });

  it('still switches preferences when storage refuses to read and write', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const store = openStore();

    store.set('enabled', false);

    expect(store.prefs().enabled).toBe(false);
  });
});
