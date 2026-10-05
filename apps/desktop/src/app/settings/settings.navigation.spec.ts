import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen } from '@testing-library/angular/zoneless';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../app.routes';
import { FleetEventsService } from '../core/fleet-events.service';
import { silentWorkingStateSignals } from '../working-state/working-state-fixtures';
import { HELM_NAV_ITEMS } from '../shell/nav-items';

const MODEL_TABLE = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' };

function stubFleetEvents() {
  return {
    sessions: signal([]),
    approvals: signal([]),
    ...silentWorkingStateSignals(),
    managers: signal([]),
    connect: () => {},
    connected: signal(true),
    snapshotReceived: signal(true),
    reconnectCount: signal(0),
    deliveredMessageIds: signal(new Set()),
    output: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }),
    sendInput: () => {},
    sendResize: () => {},
    sendAttach: () => {},
  };
}

function daemonAnswering(body: unknown) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
}

function daemonUnreachable() {
  return vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
}

async function openApp(startUrl: string) {
  TestBed.configureTestingModule({
    providers: [provideRouter(routes, withComponentInputBinding()), { provide: FleetEventsService, useValue: stubFleetEvents() }],
  });
  const harness = await RouterTestingHarness.create(startUrl);
  const root = harness.routeNativeElement as HTMLElement;
  return { harness, root, router: TestBed.inject(Router) };
}

describe('Settings navigation', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('keeps Settings out of the Helm nav list', async () => {
    const { root } = await openApp('/inbox');

    expect(root.querySelector('[data-testid="nav-settings"]')).toBeNull();
    expect(HELM_NAV_ITEMS.map((item) => item.label)).not.toContain('Settings');
  });

  it.each(HELM_NAV_ITEMS.filter((item) => item.route).map((item) => [`nav item ${item.key}`, item.route as string] as const))('routes %s (%s) to a real screen rather than the not-found page', async (_label, route) => {
    vi.stubGlobal('fetch', daemonAnswering(MODEL_TABLE));
    const { harness } = await openApp('');

    await harness.navigateByUrl(route);

    expect(harness.routeNativeElement).toBeTruthy();
    expect(harness.routeNativeElement?.querySelector('[data-testid="not-found"]')).toBeNull();
  });

  it('opens the settings screen from the sidebar gear and presses only the gear', async () => {
    vi.stubGlobal('fetch', daemonAnswering(MODEL_TABLE));
    const { harness, root, router } = await openApp('/inbox');
    const gear = screen.getByRole('button', { name: 'Settings' });
    const inboxLink = root.querySelector('[data-testid="nav-inbox"]') as HTMLAnchorElement;
    expect(gear).toHaveAttribute('aria-pressed', 'false');
    expect(inboxLink).toHaveAttribute('aria-current', 'page');

    gear.click();
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(router.url).toBe('/settings');
    expect(root.querySelector('[data-testid="settings"]')).toBeTruthy();
    expect(gear).toHaveAttribute('aria-pressed', 'true');
    expect(inboxLink).not.toHaveAttribute('aria-current');
  });

  it('opens the settings screen on ⌘,', async () => {
    vi.stubGlobal('fetch', daemonAnswering(MODEL_TABLE));
    const { harness, root, router } = await openApp('/inbox');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }));
    await harness.fixture.whenStable();

    expect(router.url).toBe('/settings');
    expect(root.querySelector('[data-testid="settings"]')).toBeTruthy();
  });

  it('shows the load error, not an endless Loading…, when /settings is opened while the daemon is down', async () => {
    vi.stubGlobal('fetch', daemonUnreachable());
    const { harness, root } = await openApp('/settings?tab=models');

    await vi.waitFor(() => {
      harness.detectChanges();
      expect(root.querySelector('[data-testid="models-error"]')).toBeTruthy();
    });

    expect(root.querySelector('[data-testid="models-loading"]')).toBeNull();
    expect(root.querySelector('[data-testid="model-row-haiku"]')).toBeNull();
  });

  it('has no command palette: ⌘K opens nothing', async () => {
    const { harness, root } = await openApp('/inbox');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    harness.detectChanges();

    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(root.querySelector('[data-testid="open-palette"]')).toBeNull();
  });
});
