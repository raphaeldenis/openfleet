import { TestBed } from '@angular/core/testing';
import { RouterTestingHarness } from '@angular/router/testing';
import { Component, signal } from '@angular/core';
import { provideRouter, withComponentInputBinding, Router, type Routes } from '@angular/router';
import { screen } from '@testing-library/angular/zoneless';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShellComponent } from './app-shell.component';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { InMemorySessionTodosSource, SESSION_TODOS_SOURCE } from './todos/session-todos-source';
import { VersionsService } from '../core/versions.service';
import type { DaemonIssue, WorkingState } from '@openfleet/shared';
import { silentWorkingStateSignals, stateOf } from '../working-state/working-state-fixtures';
import { InboxComponent } from '../inbox/inbox.component';

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
@Component({ selector: 'stub-settings', template: '<span data-testid="stub-settings">settings</span>' })
class StubSettingsComponent {}

const testRoutes: Routes = [
  {
    path: '',
    component: AppShellComponent,
    children: [
      { path: '', pathMatch: 'full', component: StubHomeComponent },
      { path: 'inbox', component: StubInboxComponent },
      { path: 'components', component: StubComponentsComponent },
      { path: 'settings', component: StubSettingsComponent },
      { path: 'session/:sessionId', component: StubSessionComponent },
    ],
  },
];

interface ShellOverrides { connected?: boolean; sessions?: unknown[]; approvals?: unknown[]; workingStates?: WorkingState[]; issues?: DaemonIssue[]; backgroundFailures?: unknown[] }

function fakeEvents(overrides: ShellOverrides = {}) {
  const workingStates = overrides.workingStates ?? [];
  return {
    sessions: signal(overrides.sessions ?? []),
    approvals: signal(overrides.approvals ?? []),
    managers: signal([]),
    connected: signal(overrides.connected ?? true),
    ...silentWorkingStateSignals(),
    daemonIssues: signal<DaemonIssue[]>(overrides.issues ?? []),
    backgroundFailures: signal(overrides.backgroundFailures ?? []),
    workingStates: signal<ReadonlyMap<string, WorkingState>>(new Map(workingStates.map((state) => [state.sessionId, state]))),
    workingStatesReported: signal(overrides.workingStates !== undefined),
  };
}

async function setUp(overrides: ShellOverrides = {}, url = '') {
  TestBed.configureTestingModule({
    providers: [
      provideRouter(testRoutes, withComponentInputBinding()),
      { provide: FleetEventsService, useValue: fakeEvents(overrides) },
      { provide: SESSION_TODOS_SOURCE, useValue: new InMemorySessionTodosSource() },
    ],
  });
  const harness = await RouterTestingHarness.create(url);
  return { harness, root: harness.routeNativeElement as HTMLElement };
}

describe('AppShellComponent', () => {
  it('renders every Helm section from the mockup, in order, each carrying a nav-<key> testid', async () => {
    const { root } = await setUp();
    const expectedOrder = [
      'nav-inbox', 'nav-project', 'nav-toolkit', 'nav-audit', 'nav-mgrprofile', 'nav-profiles',
      'nav-calendar', 'nav-notes', 'nav-tables', 'nav-triggers', 'nav-integrations', 'nav-usage',
      'nav-components',
    ];
    const found = Array.from(root.querySelectorAll('[data-testid^="nav-"]')).map((el) => el.getAttribute('data-testid'));

    expect(found).toEqual(expectedOrder);
  });

  it('renders a section without a screen yet as disabled, with its phase text, never hidden', async () => {
    const { root } = await setUp();

    const calendar = root.querySelector('[data-testid="nav-calendar"]') as HTMLElement;
    expect(calendar.tagName).not.toBe('A');
    expect(calendar).toHaveAttribute('aria-disabled', 'true');
    expect(calendar).toHaveTextContent('Calendar');
    expect(calendar).toHaveTextContent('Available in phase 5');
  });

  it('renders Notes as a real link to the notes screen', async () => {
    const { root } = await setUp();

    const notes = root.querySelector('[data-testid="nav-notes"]') as HTMLAnchorElement;

    expect(notes.tagName).toBe('A');
    expect(notes).not.toHaveAttribute('aria-disabled');
    expect(notes.getAttribute('href')).toBe('/notes');
  });

  it('renders Project home as a real link to the project home screen', async () => {
    const { root } = await setUp();

    const projectHome = root.querySelector('[data-testid="nav-project"]') as HTMLAnchorElement;

    expect(projectHome.tagName).toBe('A');
    expect(projectHome).not.toHaveAttribute('aria-disabled');
    expect(projectHome.getAttribute('href')).toBe('/project');
  });

  it('gives each disabled section the phase text from the backlog (Capitaine correction 2026-09-27)', async () => {
    const { root } = await setUp();

    expect(root.querySelector('[data-testid="nav-audit"]')).toHaveTextContent('Available in phase 4');
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

  it('renders Tables as a real link to its screen', async () => {
    const { root } = await setUp();

    const tables = root.querySelector('[data-testid="nav-tables"]') as HTMLAnchorElement;

    expect(tables.tagName).toBe('A');
    expect(tables.getAttribute('href')).toBe('/tables');
  });

  it('counts a context notice of an open session in the sidebar Inbox badge, and ignores the one of a closed session', async () => {
    const openSession = { id: 's1', name: 'Gimli', state: 'idle', contextNoticeTokens: 300_000 };
    const closedSession = { id: 's2', name: 'Legolas', state: 'closed', contextNoticeTokens: 400_000 };

    const { root } = await setUp({ sessions: [openSession, closedSession] });

    expect(root.querySelector('[data-testid="nav-inbox-badge"]')).toHaveTextContent('1');
  });

  it('drops the sidebar Inbox badge count when the Inbox dismisses an already-resolved gate', async () => {
    // Arrange
    const events = fakeEvents({
      approvals: [
        { id: 'a1', sessionId: 's1', toolName: 'Bash', toolInput: {}, status: 'pending', createdAt: 't' },
        { id: 'a2', sessionId: 's1', toolName: 'Write', toolInput: {}, status: 'pending', createdAt: 't' },
      ],
    });
    const api = { decide: vi.fn().mockRejectedValue(new ApiError(409, 'already_resolved')) };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '', component: AppShellComponent, children: [{ path: 'inbox', component: InboxComponent }] }]),
        { provide: FleetEventsService, useValue: events },
        { provide: FleetApiService, useValue: api },
      ],
    });
    const harness = await RouterTestingHarness.create('/inbox');
    const root = harness.routeNativeElement as HTMLElement;
    const badge = () => root.querySelector('[data-testid="nav-inbox-badge"]');
    expect(badge()).toHaveTextContent('2');

    // Act
    (root.querySelector('[data-testid="inbox-allow"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(root.querySelectorAll('[data-testid="inbox-gate-card"]')).toHaveLength(1));

    // Assert
    expect(badge()).toHaveTextContent('1');
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

  it('shows no permanent connection indicator while the daemon is connected', async () => {
    const { root } = await setUp({ connected: true });

    expect(root).not.toHaveTextContent('Connected');
    expect(root.querySelector('[data-testid=daemon-status]')).toBeNull();
    expect(screen.queryByTestId('banner')).toBeNull();
  });

  it('shows the reconnecting banner, with no crash and no dead end, when the socket drops', async () => {
    const { root } = await setUp({ connected: false });

    expect(root.querySelector('[data-testid="banner"]')).toHaveTextContent('Reconnecting to daemon');
  });

  it('removes the reconnecting banner once the socket is back', async () => {
    const { harness, root } = await setUp({ connected: false });
    const events = TestBed.inject(FleetEventsService) as unknown as { connected: ReturnType<typeof signal<boolean>> };
    expect(root.querySelector('[data-testid="banner"]')).toHaveTextContent('Reconnecting');

    events.connected.set(true);
    harness.detectChanges();

    expect(root.querySelector('[data-testid="banner"]')).toBeNull();
  });

  describe('degraded daemon banner', () => {
    const stuckDatabase: DaemonIssue = { code: 'db_stuck', since: '2026-09-30T10:00:00.000Z', message: 'The database is stuck.', id: '3f9a1c2e', count: 2 };

    function stubClipboard() {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      return writeText;
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('stays away while the daemon reports no issue', async () => {
      const { root } = await setUp({ issues: [] });

      expect(root.querySelector('[data-testid="degraded-banner"]')).toBeNull();
    });

    it('tells the user the daemon runs degraded, names the issue and announces it as an alert', async () => {
      const { root } = await setUp({ issues: [stuckDatabase] });

      const banner = root.querySelector('[data-testid="degraded-banner"] [role="alert"]');
      expect(banner).toHaveTextContent('The daemon hit a problem and is running degraded');
      expect(banner).toHaveTextContent('The database is stuck');
      expect(banner).toHaveTextContent('restart it when convenient');
    });

    it('never shows the raw code of the issue', async () => {
      const { root } = await setUp({ issues: [stuckDatabase] });

      expect(root.querySelector('[data-testid="degraded-banner"]')).not.toHaveTextContent('db_stuck');
    });

    it('mentions the other issues when several are active', async () => {
      const { root } = await setUp({ issues: [stuckDatabase, { ...stuckDatabase, code: 'hook_fail_open', id: 'aaaaaaaa' }] });

      expect(root.querySelector('[data-testid="degraded-banner"]')).toHaveTextContent('+1 more');
    });

    it('copies the ref, the code, the message and the time, and nothing else, with Copy details', async () => {
      const writeText = stubClipboard();
      const issueWithForeignFields = { ...stuckDatabase, hint: 'see /Users/ana/.openfleet/db', token: 'Bearer abc123' } as DaemonIssue;
      const { root } = await setUp({ issues: [issueWithForeignFields] });

      (root.querySelector('[data-testid="degraded-copy-details"]') as HTMLButtonElement).click();

      const copied = writeText.mock.calls[0]![0] as string;
      expect(copied).toContain('ref 3f9a1c2e');
      expect(copied).toContain('db_stuck');
      expect(copied).toContain('The database is stuck.');
      expect(copied).toContain('2026-09-30T10:00:00.000Z');
      expect(copied).not.toMatch(/bearer|abc123|\/Users\//i);
    });

    describe('daemon words of a hostile issue', () => {
      const hostileIssue: DaemonIssue = { ...stuckDatabase, message: 'Cannot open /Users/review-user/db; Bearer SYNTHETIC_TOKEN_123; safe‮evil​.' };

      it('shows the message without credentials or home path, and its invisible characters as escapes', async () => {
        const { root } = await setUp({ issues: [hostileIssue] });

        const banner = root.querySelector('[data-testid="degraded-banner"]');
        expect(banner).toHaveTextContent('Cannot open ~/db; Bearer ***; safe<U+202E>evil<U+200B>');
        expect(banner!.textContent).not.toMatch(/SYNTHETIC_TOKEN_123|review-user|[‮​]/);
      });

      it('copies the message without credentials, home path or raw invisible characters', async () => {
        const writeText = stubClipboard();
        const { root } = await setUp({ issues: [hostileIssue] });

        (root.querySelector('[data-testid="degraded-copy-details"]') as HTMLButtonElement).click();

        const copied = writeText.mock.calls[0]![0] as string;
        expect(copied).toContain('Cannot open ~/db; Bearer ***; safe<U+202E>evil<U+200B>');
        expect(copied).not.toMatch(/SYNTHETIC_TOKEN_123|review-user|[‮​]/);
      });

      it('copies the daemon version without raw invisible characters', async () => {
        const writeText = stubClipboard();
        const { harness, root } = await setUp({ issues: [stuckDatabase] });
        TestBed.inject(VersionsService).daemonVersion.set('1.4.2‮');
        harness.detectChanges();

        (root.querySelector('[data-testid="degraded-copy-details"]') as HTMLButtonElement).click();

        expect(writeText.mock.calls[0]![0]).toContain('daemon: 1.4.2<U+202E>');
      });
    });

    it('adds the daemon version to the copied details when it is known', async () => {
      const writeText = stubClipboard();
      const { harness, root } = await setUp({ issues: [stuckDatabase] });
      TestBed.inject(VersionsService).daemonVersion.set('1.4.2');
      harness.detectChanges();

      (root.querySelector('[data-testid="degraded-copy-details"]') as HTMLButtonElement).click();

      expect(writeText.mock.calls[0]![0]).toContain('daemon: 1.4.2');
    });

    it('separates the details of two issues with a blank line', async () => {
      const writeText = stubClipboard();
      const { root } = await setUp({ issues: [stuckDatabase, { ...stuckDatabase, code: 'hook_fail_open', id: 'aaaaaaaa' }] });

      (root.querySelector('[data-testid="degraded-copy-details"]') as HTMLButtonElement).click();

      const [first, second, ...rest] = (writeText.mock.calls[0]![0] as string).split('\n\n');
      expect(first).toContain('ref 3f9a1c2e');
      expect(second).toContain('ref aaaaaaaa');
      expect(rest).toEqual([]);
    });

    it('does not double the period of the issue message before the advice', async () => {
      const { root } = await setUp({ issues: [stuckDatabase] });

      expect(root.querySelector('[data-testid="degraded-banner"]')).toHaveTextContent('The database is stuck — restart it when convenient.');
    });

    it('says an issue that clears by itself may clear by itself, and does not ask for a restart', async () => {
      const { root } = await setUp({ issues: [{ ...stuckDatabase, code: 'hook_fail_open' }] });

      const banner = root.querySelector('[data-testid="degraded-banner"]');
      expect(banner).toHaveTextContent('it may clear by itself');
      expect(banner).not.toHaveTextContent('restart');
    });

    it('lets a keyboard user reach Copy details and confirms the copy', async () => {
      stubClipboard();
      const { harness, root } = await setUp({ issues: [stuckDatabase] });
      const button = root.querySelector('[data-testid="degraded-copy-details"]') as HTMLButtonElement;

      button.focus();
      button.click();
      await vi.waitFor(() => {
        harness.detectChanges();
        expect(button).toHaveTextContent('Copied');
      });

      expect(document.activeElement).toBe(button);
      expect(root.querySelector('[data-testid="degraded-copy-details"]')).toBe(button);
    });

    describe('the Inbox nav item', () => {
      const backgroundFailure = { key: 'f1', sessionId: 's1', at: '2026-09-30T10:00:00.000Z', envelope: { error: 'delivery_failed', kind: 'unavailable', retry: 'later', message: 'x' } };

      it('carries an issue dot, announced as such, while a background failure is pending', async () => {
        const { root } = await setUp({ backgroundFailures: [backgroundFailure] });

        expect(root.querySelector('[data-testid="nav-inbox-issue-dot"]')).toHaveAttribute('aria-label', 'Inbox has issues');
      });

      it('has no dot when nothing failed in the background', async () => {
        const { root } = await setUp({ backgroundFailures: [] });

        expect(root.querySelector('[data-testid="nav-inbox-issue-dot"]')).toBeNull();
      });

      it('leaves the count of items needing you to gates and questions', async () => {
        const { root } = await setUp({ backgroundFailures: [backgroundFailure] });

        expect(root.querySelector('[data-testid="nav-inbox-badge"]')).toBeNull();
      });
    });

    it('disappears once the daemon reports an empty list', async () => {
      const { harness, root } = await setUp({ issues: [stuckDatabase] });
      const events = TestBed.inject(FleetEventsService) as unknown as { daemonIssues: ReturnType<typeof signal<DaemonIssue[]>> };

      events.daemonIssues.set([]);
      harness.detectChanges();

      expect(root.querySelector('[data-testid="degraded-banner"]')).toBeNull();
    });
  });

  it('gives the Sessions region and the Helm list independent scroll areas so neither can grow over the other', async () => {
    const { root } = await setUp();
    const sessions = root.querySelector('[data-testid="app-nav"] .sessions') as HTMLElement;
    const helmList = root.querySelector('[data-testid="app-nav"] .helm-list') as HTMLElement;

    const sessionRows = sessions.querySelector('ul.sessions') as HTMLElement;
    const sessionsStyle = getComputedStyle(sessions);
    const helmListStyle = getComputedStyle(helmList);

    expect(getComputedStyle(sessionRows).overflowY).toBe('auto');
    expect(sessionsStyle.minHeight).toBe('0px');
    expect(sessionsStyle.flexGrow).toBe('2');
    expect(helmListStyle.overflowY).toBe('auto');
    expect(helmListStyle.minHeight).toBe('0px');
    expect(helmListStyle.flexGrow).toBe('1.4');
  });

  it('pins the new-session and new-manager links outside the scrolling session rows so many sessions never push them out of reach', async () => {
    const manySessions = Array.from({ length: 40 }, (_, index) => ({ id: `s${index}`, name: `Session ${index}`, emoji: '🤖', state: 'idle' }));
    const { root } = await setUp({ sessions: manySessions });
    const sessionsRegion = root.querySelector('[data-testid="app-nav"] .sessions') as HTMLElement;
    const scrollingRows = sessionsRegion.querySelector('ul.sessions') as HTMLElement;
    const newSessionLink = root.querySelector('[data-testid="new-session-link"]') as HTMLElement;
    const newManagerLink = root.querySelector('[data-testid="new-manager-link"]') as HTMLElement;

    const isScrollContainer = (element: HTMLElement) => ['auto', 'scroll'].includes(getComputedStyle(element).overflowY);
    const scrollContainersAbove = (link: HTMLElement) => {
      const containers: HTMLElement[] = [];
      for (let ancestor = link.parentElement; ancestor && ancestor !== sessionsRegion.parentElement; ancestor = ancestor.parentElement) {
        if (isScrollContainer(ancestor)) containers.push(ancestor);
      }
      return containers;
    };

    expect(isScrollContainer(scrollingRows)).toBe(true);
    expect(scrollingRows.contains(newSessionLink)).toBe(false);
    expect(scrollContainersAbove(newSessionLink)).toEqual([]);
    expect(scrollContainersAbove(newManagerLink)).toEqual([]);
  });

  it('badges the Helm Inbox row with the pending approvals count, hidden when there are none', async () => {
    const { root } = await setUp({ approvals: [{ id: 'a1' }, { id: 'a2' }] });

    const inbox = root.querySelector('[data-testid="nav-inbox"]') as HTMLElement;
    const badge = inbox.querySelector('[data-testid="nav-inbox-badge"]');
    expect(badge).toHaveTextContent('2');
  });

  describe('Inbox badge with sessions needing attention', () => {
    const openSession = (id: string) => ({ id, name: `Agent ${id}`, emoji: '🤖', state: 'idle' });
    const badgeOf = (root: HTMLElement) => root.querySelector('[data-testid="nav-inbox"] [data-testid="nav-inbox-badge"]');

    it('user sees approvals plus the sessions that ask a question or report a blocker', async () => {
      const { root } = await setUp({
        approvals: [{ id: 'a1' }, { id: 'a2' }],
        sessions: [openSession('s1'), openSession('s2'), openSession('s3'), openSession('s4')],
        workingStates: [
          stateOf({ sessionId: 's1', questionsForHuman: ['which port?'] }),
          stateOf({ sessionId: 's2', blockers: ['no token'] }),
          stateOf({ sessionId: 's3', questionsForHuman: ['a?'], blockers: ['b'] }),
          stateOf({ sessionId: 's4', plan: ['just working'], internalQuestions: ['not for the human'] }),
        ],
      });

      expect(badgeOf(root)).toHaveTextContent('5');
    });

    it('user sees the badge for a question alone, with no approval pending', async () => {
      const { root } = await setUp({ sessions: [openSession('s1')], workingStates: [stateOf({ sessionId: 's1', questionsForHuman: ['which port?'] })] });

      expect(badgeOf(root)).toHaveTextContent('1');
    });

    it('user sees no badge when the sessions only have plans, todos and internal questions', async () => {
      const { root } = await setUp({ sessions: [openSession('s1')], workingStates: [stateOf({ sessionId: 's1', plan: ['a'], todo: ['b'], remaining: ['c'], internalQuestions: ['d'] })] });

      expect(badgeOf(root)).toBeFalsy();
    });

    it('user does not see a closed session in the badge', async () => {
      const { root } = await setUp({ sessions: [{ ...openSession('s1'), state: 'closed' }], workingStates: [stateOf({ sessionId: 's1', blockers: ['stuck'] })] });

      expect(badgeOf(root)).toBeFalsy();
    });

    it('user sees the real count up to 99 and "99+" beyond, with the true number for a screen reader', async () => {
      const manySessions = Array.from({ length: 100 }, (_, index) => openSession(`s${index}`));
      const { root } = await setUp({
        sessions: manySessions,
        workingStates: manySessions.map((session) => stateOf({ sessionId: session.id, blockers: ['stuck'] })),
        approvals: [{ id: 'a1' }, { id: 'a2' }],
      });

      expect(badgeOf(root)).toHaveTextContent('99+');
      expect(screen.getByRole('img', { name: '102 items need you' })).toBe(badgeOf(root));
    });

    it('user sees exactly 99 as "99" and gets the count in the label', async () => {
      const ninetyNine = Array.from({ length: 99 }, (_, index) => ({ id: `a${index}` }));
      const { root } = await setUp({ approvals: ninetyNine });

      expect(badgeOf(root)).toHaveTextContent(/^99$/);
      expect(badgeOf(root)).toHaveAttribute('aria-label', '99 items need you');
    });

    it('user reads "1 item needs you" for a single item', async () => {
      const { root } = await setUp({ approvals: [{ id: 'a1' }] });

      expect(badgeOf(root)).toHaveAttribute('aria-label', '1 item needs you');
    });
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

  it('never lets a disabled nav item navigate, by click or by keyboard, since it renders as inert text rather than a link', async () => {
    const { harness, root } = await setUp();
    const router = TestBed.inject(Router);
    const calendar = root.querySelector('[data-testid="nav-calendar"]') as HTMLElement;

    expect(calendar.tagName).toBe('SPAN');
    expect(calendar).not.toHaveAttribute('tabindex');
    expect(calendar.getAttribute('href')).toBeNull();

    calendar.click();
    await harness.fixture.whenStable();

    expect(router.url).toBe('/');
  });

  it('has no top bar, no status bar and no search trigger', async () => {
    const { root } = await setUp();

    expect(root.querySelector('[data-testid="app-topbar"]')).toBeNull();
    expect(root.querySelector('[data-testid="app-statusbar"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /search|command palette/i })).toBeNull();
  });

  it('opens no command palette on ⌘K', async () => {
    const { harness, root } = await setUp();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    await harness.fixture.whenStable();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(root.querySelector('[data-testid="command-palette"]')).toBeNull();
  });

  it('opens Settings on ⌘,', async () => {
    const { harness } = await setUp();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }));
    await harness.fixture.whenStable();

    expect(TestBed.inject(Router).url).toBe('/settings');
    expect(screen.getByTestId('stub-settings')).toBeInTheDocument();
  });

  it('puts the theme toggle in the sidebar footer, beside the settings gear', async () => {
    const { root } = await setUp();

    const footer = root.querySelector('[data-testid="app-nav"] [data-testid="sidebar-footer"]') as HTMLElement;

    expect(footer.querySelector('[data-testid="theme-toggle"]')).toBeTruthy();
    expect(footer.querySelector('[data-testid="settings-gear"]')).toBeTruthy();
  });

  it('keeps the right panel closed until the rail button opens it beside the session view', async () => {
    vi.stubGlobal('localStorage', { getItem: () => 'false', setItem: () => undefined });
    const { harness, root } = await setUp({}, '/session/s1');
    const rail = root.querySelector('[aria-label="Show the right panel"]') as HTMLElement;
    expect(root.querySelector('[data-testid="right-panel"]')).toBeNull();

    rail.click();
    await harness.fixture.whenStable();

    expect(root.querySelector('[data-testid="right-panel"]')).not.toBeNull();
    vi.unstubAllGlobals();
  });

  it.each(['true', 'false'])('gives the panel to the selected session only and the whole width to every other page, whatever the remembered open state (%s)', async (rememberedOpen) => {
    vi.stubGlobal('localStorage', { getItem: () => rememberedOpen, setItem: () => undefined });
    const { harness, root } = await setUp({}, '/session/s1');
    const hasPanelChrome = () => root.querySelector('[data-testid="right-panel"], [data-testid="right-panel-rail"]') !== null;
    expect(hasPanelChrome()).toBe(true);

    for (const otherPage of ['/inbox', '/settings', '/']) {
      await harness.navigateByUrl(otherPage);
      expect(hasPanelChrome(), otherPage).toBe(false);
    }
    vi.unstubAllGlobals();
  });
});
