import { TestBed } from '@angular/core/testing';
import { RouterTestingHarness } from '@angular/router/testing';
import { Component, signal } from '@angular/core';
import { provideRouter, withComponentInputBinding, Router, type Routes } from '@angular/router';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppShellComponent } from './app-shell.component';
import { FleetEventsService } from '../core/fleet-events.service';

// jsdom doesn't block focus() inside an inert subtree the way the WHATWG spec requires real
// browsers to: without this shim, a focus() call fired before Angular's change detection removes
// `inert` silently "succeeds" here while landing on <body> for real — the exact bug QA caught.
const nativeFocus = HTMLElement.prototype.focus;
beforeAll(() => {
  HTMLElement.prototype.focus = function focusUnlessInert(this: HTMLElement, options?: FocusOptions): void {
    if (this.closest('[inert]')) return;
    nativeFocus.call(this, options);
  };
});
afterAll(() => {
  HTMLElement.prototype.focus = nativeFocus;
});

@Component({
  selector: 'stub-home',
  template: '<span data-testid="stub-home">home</span><button data-testid="stub-home-opener" type="button">Open from page</button>',
})
class StubHomeComponent {}
@Component({ selector: 'stub-inbox', template: '<span data-testid="stub-inbox">inbox</span>' })
class StubInboxComponent {}
@Component({ selector: 'stub-components', template: '<span data-testid="stub-components">components</span>' })
class StubComponentsComponent {}
@Component({ selector: 'stub-session', template: '<span data-testid="stub-session">session</span>' })
class StubSessionComponent {}

const testRoutes: Routes = [
  {
    path: '',
    component: AppShellComponent,
    children: [
      { path: '', pathMatch: 'full', component: StubHomeComponent },
      { path: 'inbox', component: StubInboxComponent },
      { path: 'components', component: StubComponentsComponent },
      { path: 'session/:sessionId', component: StubSessionComponent },
    ],
  },
];

function fakeEvents(overrides: { connected?: boolean; sessions?: unknown[]; approvals?: unknown[] } = {}) {
  return {
    sessions: signal(overrides.sessions ?? []),
    approvals: signal(overrides.approvals ?? []),
    managers: signal([]),
    connected: signal(overrides.connected ?? true),
  };
}

async function setUp(overrides: { connected?: boolean; sessions?: unknown[]; approvals?: unknown[] } = {}) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter(testRoutes, withComponentInputBinding()),
      { provide: FleetEventsService, useValue: fakeEvents(overrides) },
    ],
  });
  const harness = await RouterTestingHarness.create('');
  return { harness, root: harness.routeNativeElement as HTMLElement };
}

describe('AppShellComponent', () => {
  it('renders every Helm section from the mockup, in order, each carrying a nav-<key> testid', async () => {
    const { root } = await setUp();
    const expectedOrder = [
      'nav-inbox', 'nav-project', 'nav-toolkit', 'nav-audit', 'nav-mgrprofile', 'nav-profiles',
      'nav-calendar', 'nav-notes', 'nav-tables', 'nav-triggers', 'nav-integrations', 'nav-usage',
      'nav-settings', 'nav-components',
    ];
    const found = Array.from(root.querySelectorAll('[data-testid^="nav-"]')).map((el) => el.getAttribute('data-testid'));

    expect(found).toEqual(expectedOrder);
  });

  it('renders a section without a screen yet as disabled, with its phase text, never hidden', async () => {
    const { root } = await setUp();

    const notes = root.querySelector('[data-testid="nav-notes"]') as HTMLElement;
    expect(notes.tagName).not.toBe('A');
    expect(notes).toHaveAttribute('aria-disabled', 'true');
    expect(notes).toHaveTextContent('Notes');
    expect(notes).toHaveTextContent('Available in phase 3');
  });

  it('gives each disabled section the phase text from the backlog (Capitaine correction 2026-09-27)', async () => {
    const { root } = await setUp();

    expect(root.querySelector('[data-testid="nav-project"]')).toHaveTextContent('Available in phase 3');
    expect(root.querySelector('[data-testid="nav-audit"]')).toHaveTextContent('Available in phase 4');
    expect(root.querySelector('[data-testid="nav-settings"]')).toHaveTextContent('Available in phase 2');
    expect(root.querySelector('[data-testid="nav-toolkit"]')).toHaveTextContent('Available in phase 4');
    expect(root.querySelector('[data-testid="nav-mgrprofile"]')).toHaveTextContent('Available in phase 4');
    expect(root.querySelector('[data-testid="nav-profiles"]')).toHaveTextContent('Not yet available');
  });

  it('renders Inbox as a real link that routes to its own panel', async () => {
    const { harness, root } = await setUp();
    const inbox = root.querySelector('[data-testid="nav-inbox"]') as HTMLAnchorElement;
    expect(inbox.tagName).toBe('A');

    inbox.click();
    await harness.fixture.whenStable();

    expect(root.querySelector('[data-testid="stub-inbox"]')).toBeTruthy();
  });

  it('renders Component sheet as a real link, staying reachable as a dev route', async () => {
    const { harness, root } = await setUp();
    const components = root.querySelector('[data-testid="nav-components"]') as HTMLAnchorElement;
    expect(components.tagName).toBe('A');

    components.click();
    await harness.fixture.whenStable();

    expect(root.querySelector('[data-testid="stub-components"]')).toBeTruthy();
  });

  it('embeds the Sessions lineage tree above the Helm sections', async () => {
    const { root } = await setUp({ sessions: [{ id: 's1', name: 'Gimli', emoji: '⚔️', state: 'idle' }] });

    expect(root.querySelector('of-session-list')).toBeTruthy();
    expect(root.querySelector('[data-testid="session-s1"]')).toBeTruthy();
  });

  it('navigates to a plain session\'s terminal when it is picked from the Sessions tree', async () => {
    const { harness, root } = await setUp({ sessions: [{ id: 's1', name: 'Gimli', emoji: '⚔️', state: 'idle' }] });

    (root.querySelector('[data-testid="session-s1"]') as HTMLElement).click();
    await harness.fixture.whenStable();

    expect(root.querySelector('[data-testid="stub-session"]')).toBeTruthy();
  });

  it('shows the daemon as connected in the top bar when FleetEventsService.connected is true', async () => {
    const { root } = await setUp({ connected: true });

    const status = root.querySelector('[data-testid="app-topbar"] [data-testid="daemon-status"]');
    expect(status).toHaveTextContent('Connected');
  });

  it('shows the daemon as reconnecting, with no crash and no dead end, when the socket drops', async () => {
    const { root } = await setUp({ connected: false });

    const status = root.querySelector('[data-testid="app-topbar"] [data-testid="daemon-status"]');
    expect(status).toHaveTextContent('Reconnecting');
    expect(root.querySelector('[data-testid="banner"]')).toHaveTextContent('Reconnecting');
  });

  it('shows a not-tracked spend placeholder in the top bar with its tooltip', async () => {
    const { root } = await setUp();

    const spend = root.querySelector('[data-testid="spend-today"]') as HTMLElement;
    expect(spend).toHaveTextContent('—');
    expect(spend).toHaveAttribute('title', 'Cost tracking is not implemented yet');
  });

  it('shows the daemon address, connection state and a not-tracked limits placeholder in the status bar', async () => {
    const { root } = await setUp();

    const statusBar = root.querySelector('[data-testid="app-statusbar"]') as HTMLElement;
    expect(statusBar).toHaveTextContent('127.0.0.1:7331');
    expect(statusBar.querySelector('[data-testid="daemon-status"]')).toBeTruthy();
    const limits = statusBar.querySelector('[data-testid="status-limits"]') as HTMLElement;
    expect(limits).toHaveTextContent('—');
    expect(limits).toHaveAttribute('title', 'Provider limits are not tracked yet');
  });

  it('opens the command palette from the search slot, listing Pages only', async () => {
    const { harness, root } = await setUp();

    (root.querySelector('[data-testid="open-palette"]') as HTMLElement).click();
    await harness.fixture.whenStable();

    expect(root.querySelector('[data-testid="command-palette"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="palette-item-sessions"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="palette-item-inbox"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="palette-item-components"]')).toBeTruthy();
  });

  it('toggles the command palette open with ⌘K from anywhere in the shell', async () => {
    const { harness, root } = await setUp();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    await harness.fixture.whenStable();

    expect(root.querySelector('[data-testid="command-palette"]')).toBeTruthy();
  });

  it('closes the command palette with Escape', async () => {
    const { harness, root } = await setUp();
    (root.querySelector('[data-testid="open-palette"]') as HTMLElement).click();
    await harness.fixture.whenStable();
    expect(root.querySelector('[data-testid="command-palette"]')).toBeTruthy();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await harness.fixture.whenStable();

    expect(root.querySelector('[data-testid="command-palette"]')).toBeFalsy();
  });

  it('closes the palette when ⌘K is pressed again while it is already open', async () => {
    const { harness, root } = await setUp();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    await harness.fixture.whenStable();
    expect(root.querySelector('[data-testid="command-palette"]')).toBeTruthy();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    await harness.fixture.whenStable();

    expect(root.querySelector('[data-testid="command-palette"]')).toBeFalsy();
  });

  it('moves focus into the command palette when it opens and returns it to the search slot when it closes, so a keyboard-only user is never dropped', async () => {
    const { harness, root } = await setUp();
    const trigger = root.querySelector('[data-testid="open-palette"]') as HTMLElement;
    trigger.focus();

    trigger.click();
    await harness.fixture.whenStable();

    const palette = root.querySelector('[data-testid="command-palette"]') as HTMLElement;
    expect(palette.contains(document.activeElement)).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await harness.fixture.whenStable();

    expect(document.activeElement).toBe(trigger);
  });

  it('gives the Sessions region and the Helm list independent scroll areas so neither can grow over the other', async () => {
    const { root } = await setUp();
    const sessions = root.querySelector('[data-testid="app-nav"] .sessions') as HTMLElement;
    const helmList = root.querySelector('[data-testid="app-nav"] .helm-list') as HTMLElement;

    const sessionsStyle = getComputedStyle(sessions);
    const helmListStyle = getComputedStyle(helmList);

    expect(sessionsStyle.overflowY).toBe('auto');
    expect(sessionsStyle.minHeight).toBe('0px');
    expect(sessionsStyle.flexGrow).toBe('2');
    expect(helmListStyle.overflowY).toBe('auto');
    expect(helmListStyle.minHeight).toBe('0px');
    expect(helmListStyle.flexGrow).toBe('1.4');
  });

  it('scrolls the Sessions region internally even with zero sessions, so the tall new-session/new-manager forms never spill onto the Helm list below', async () => {
    const { root } = await setUp({ sessions: [] });
    const sessions = root.querySelector('[data-testid="app-nav"] .sessions') as HTMLElement;
    const sessionListHost = root.querySelector('[data-testid="app-nav"] of-session-list') as HTMLElement;

    const sessionsStyle = getComputedStyle(sessions);
    expect(sessionsStyle.overflowY).toBe('auto');
    expect(sessions.contains(sessionListHost.querySelector('of-new-manager-form'))).toBe(true);
  });

  it('badges the Helm Inbox row with the pending approvals count, hidden when there are none', async () => {
    const { root } = await setUp({ approvals: [{ id: 'a1' }, { id: 'a2' }] });

    const inbox = root.querySelector('[data-testid="nav-inbox"]') as HTMLElement;
    const badge = inbox.querySelector('[data-testid="nav-inbox-badge"]');
    expect(badge).toHaveTextContent('2');
  });

  it('hides the Inbox badge when there are no pending approvals', async () => {
    const { root } = await setUp();

    const inbox = root.querySelector('[data-testid="nav-inbox"]') as HTMLElement;
    expect(inbox.querySelector('[data-testid="nav-inbox-badge"]')).toBeFalsy();
  });

  it('highlights the nav item for the current route with .active', async () => {
    const { harness, root } = await setUp();
    const inbox = root.querySelector('[data-testid="nav-inbox"]') as HTMLAnchorElement;

    inbox.click();
    await harness.fixture.whenStable();

    expect(inbox.classList.contains('active')).toBe(true);
    const components = root.querySelector('[data-testid="nav-components"]') as HTMLElement;
    expect(components.classList.contains('active')).toBe(false);
  });

  it('lets routed pages scroll inside the outlet instead of clipping their content', async () => {
    const { root } = await setUp();

    const outlet = root.querySelector('[data-testid="app-outlet"]') as HTMLElement;

    expect(getComputedStyle(outlet).overflowY).toBe('auto');
  });

  it('restores focus to the element that opened the palette, not always the search trigger, when it closes', async () => {
    const { harness, root } = await setUp();
    const inbox = root.querySelector('[data-testid="nav-inbox"]') as HTMLElement;
    inbox.focus();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    await harness.fixture.whenStable();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await harness.fixture.whenStable();

    expect(document.activeElement).toBe(inbox);
  });

  it('falls back to the search trigger when the palette opener no longer exists in the DOM', async () => {
    const { harness, root } = await setUp();
    const inbox = root.querySelector('[data-testid="nav-inbox"]') as HTMLElement;
    inbox.focus();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    await harness.fixture.whenStable();

    inbox.remove();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await harness.fixture.whenStable();

    const trigger = root.querySelector('[data-testid="open-palette"]') as HTMLElement;
    expect(document.activeElement).toBe(trigger);
  });

  it('falls back to the search trigger when picking a palette item destroys the outlet opener via navigation', async () => {
    const { harness, root } = await setUp();
    const opener = root.querySelector('[data-testid="stub-home-opener"]') as HTMLElement;
    opener.focus();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    await harness.fixture.whenStable();
    (root.querySelector('[data-testid="palette-item-inbox"]') as HTMLElement).click();
    await harness.fixture.whenStable();

    const trigger = root.querySelector('[data-testid="open-palette"]') as HTMLElement;
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps a reopened palette showing when a stale navigation from the closed opening resolves late', async () => {
    const { harness, root } = await setUp();
    const router = TestBed.inject(Router);
    let resolveStaleNavigation!: (value: boolean) => void;
    const staleNavigation = new Promise<boolean>((resolve) => (resolveStaleNavigation = resolve));
    vi.spyOn(router, 'navigate').mockReturnValue(staleNavigation);
    const firstOpener = root.querySelector('[data-testid="nav-inbox"]') as HTMLElement;
    firstOpener.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    await harness.fixture.whenStable();
    (root.querySelector('[data-testid="palette-item-inbox"]') as HTMLElement).click();
    await harness.fixture.whenStable();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await harness.fixture.whenStable();
    expect(root.querySelector('[data-testid="command-palette"]')).toBeFalsy();

    const secondOpener = root.querySelector('[data-testid="nav-components"]') as HTMLElement;
    secondOpener.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    await harness.fixture.whenStable();
    expect(root.querySelector('[data-testid="command-palette"]')).toBeTruthy();

    resolveStaleNavigation(true);
    await staleNavigation;
    await harness.fixture.whenStable();

    expect(root.querySelector('[data-testid="command-palette"]')).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await harness.fixture.whenStable();
    expect(document.activeElement).toBe(secondOpener);
  });

  it('falls back to the search trigger when ⌘K opens the palette with nothing focused beforehand', async () => {
    const { harness, root } = await setUp();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    await harness.fixture.whenStable();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await harness.fixture.whenStable();

    const trigger = root.querySelector('[data-testid="open-palette"]') as HTMLElement;
    expect(document.activeElement).toBe(trigger);
  });

  it('makes the rest of the shell inert to assistive tech while the palette is open, and reachable again once it closes', async () => {
    const { harness, root } = await setUp();

    (root.querySelector('[data-testid="open-palette"]') as HTMLElement).click();
    await harness.fixture.whenStable();

    const body = root.querySelector('.body') as HTMLElement;
    const statusBar = root.querySelector('[data-testid="app-statusbar"]') as HTMLElement;
    expect(body).toHaveAttribute('inert');
    expect(statusBar).toHaveAttribute('inert');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await harness.fixture.whenStable();

    expect(body).not.toHaveAttribute('inert');
    expect(statusBar).not.toHaveAttribute('inert');
  });

  it('never lets a disabled nav item navigate, by click or by keyboard, since it renders as inert text rather than a link', async () => {
    const { harness, root } = await setUp();
    const router = TestBed.inject(Router);
    const notes = root.querySelector('[data-testid="nav-notes"]') as HTMLElement;

    expect(notes.tagName).toBe('SPAN');
    expect(notes).not.toHaveAttribute('tabindex');
    expect(notes.getAttribute('href')).toBeNull();

    notes.click();
    await harness.fixture.whenStable();

    expect(router.url).toBe('/');
  });
});
