import { TestBed } from '@angular/core/testing';
import { RouterTestingHarness } from '@angular/router/testing';
import { Component, signal } from '@angular/core';
import { provideRouter, withComponentInputBinding, type Routes } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { AppShellComponent } from './app-shell.component';
import { FleetEventsService } from '../core/fleet-events.service';

@Component({ selector: 'stub-home', template: '<span data-testid="stub-home">home</span>' })
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

function fakeEvents(overrides: { connected?: boolean; sessions?: unknown[] } = {}) {
  return {
    sessions: signal(overrides.sessions ?? []),
    approvals: signal([]),
    managers: signal([]),
    connected: signal(overrides.connected ?? true),
  };
}

async function setUp(overrides: { connected?: boolean; sessions?: unknown[] } = {}) {
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
});
