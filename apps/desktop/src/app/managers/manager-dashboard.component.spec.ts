import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { signal } from '@angular/core';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { BehaviorSubject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ManagerDashboardComponent } from './manager-dashboard.component';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

const emptyGovernance = { resourceGrants: [], pending: [], denied: [], history: [], governanceEvictedDenials: 0 };
const governanceApi = { getManagerGovernance: () => Promise.resolve(emptyGovernance) };

function activatedRouteFor(id: string) {
  return { paramMap: of(convertToParamMap({ id })) };
}

function fakeEvents(overrides: { sessions?: unknown[]; managers?: unknown[]; snapshotReceived?: boolean; workingStatesReported?: boolean } = {}) {
  return {
    sessions: signal(overrides.sessions ?? []),
    approvals: signal([]),
    proposals: signal([]),
    managers: signal(overrides.managers ?? []),
    snapshotReceived: signal(overrides.snapshotReceived ?? true),
    workingStates: signal(new Map()),
    workingStatesReported: signal(overrides.workingStatesReported ?? false),
    workingStateMaxAgeMinutes: signal<number | undefined>(30),
    workingStateMaxBytes: signal<number | undefined>(6144),
  };
}

const MANAGER_SESSION = { id: 'm1', name: 'Lead', emoji: '🧭', role: 'manager', state: 'idle', harness: 'claude-cli' };
const MANAGER_VIEW = { sessionId: 'm1', pulseSeconds: 1800, pulseEnabled: true, childrenCap: 2, missionText: 'x', nextPulseAt: new Date(Date.now() + 42_000).toISOString(), childrenCount: 1 };
const CHILD_SESSION = { id: 'c1', name: 'Gimli', emoji: '⚔️', parentId: 'm1', state: 'generating', harness: 'claude-cli' };

describe('ManagerDashboardComponent state overdue chip', () => {
  const renderDashboard = (fake: ReturnType<typeof fakeEvents>) =>
    render(ManagerDashboardComponent, {
      providers: [provideRouter([]), { provide: ActivatedRoute, useValue: activatedRouteFor('m1') }, { provide: FleetEventsService, useValue: fake }, { provide: FleetApiService, useValue: governanceApi }],
    });

  it('user sees "state overdue" in the header of a manager that has no state', async () => {
    await renderDashboard(fakeEvents({ sessions: [MANAGER_SESSION], managers: [MANAGER_VIEW], workingStatesReported: true }));

    expect(within(screen.getByTestId('manager-dashboard')).getByTestId('overdue-chip')).toBeTruthy();
  });

  it('user sees no chip when the daemon does not report working states', async () => {
    await renderDashboard(fakeEvents({ sessions: [MANAGER_SESSION], managers: [MANAGER_VIEW], workingStatesReported: false }));

    expect(screen.queryByTestId('overdue-chip')).toBeNull();
  });
});

describe('ManagerDashboardComponent pause control', () => {
  const renderDashboardOf = (managerView: object, api: object = {}, managerSession: object = MANAGER_SESSION) =>
    render(ManagerDashboardComponent, {
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: activatedRouteFor('m1') },
        { provide: FleetApiService, useValue: { ...governanceApi, ...api } },
        { provide: FleetEventsService, useValue: fakeEvents({ sessions: [managerSession], managers: [managerView] }) },
      ],
    });

  it('pauses the pulses of a running manager from the live controls', async () => {
    const api = { updateManager: vi.fn().mockResolvedValue({}) };
    await renderDashboardOf(MANAGER_VIEW, api);

    await userEvent.click(screen.getByRole('button', { name: 'Pause pulses of Lead' }));

    expect(api.updateManager).toHaveBeenCalledWith('m1', { pulseEnabled: false });
  });

  it('tells whether the pulses are paused through the pressed state of the pause button', async () => {
    await renderDashboardOf(MANAGER_VIEW);

    expect(screen.getByRole('button', { name: 'Pause pulses of Lead' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('offers no pause button for a closed session', async () => {
    await renderDashboardOf(MANAGER_VIEW, {}, { ...MANAGER_SESSION, state: 'closed' });

    expect(screen.queryByTestId('manager-dashboard-pause')).toBeNull();
  });

  it('shows the error of a failing pause and lets the user pause again', async () => {
    const api = { updateManager: vi.fn().mockRejectedValue(new ApiError(500, 'PATCH /api/managers/m1 → 500', 'internal_error')) };
    await renderDashboardOf(MANAGER_VIEW, api);

    await userEvent.click(screen.getByRole('button', { name: 'Pause pulses of Lead' }));

    expect(screen.getByTestId('manager-dashboard-pulse-message')).toHaveTextContent('The daemon hit an unexpected error');
    expect(screen.getByRole('button', { name: 'Pause pulses of Lead' })).toBeEnabled();
  });

  it('shows the pause error instead of the message left by an earlier pulse', async () => {
    const api = {
      pulseNow: vi.fn().mockResolvedValue({ coalesced: true }),
      updateManager: vi.fn().mockRejectedValue(new ApiError(500, 'PATCH /api/managers/m1 → 500', 'internal_error')),
    };
    await renderDashboardOf(MANAGER_VIEW, api);
    await userEvent.click(screen.getByTestId('manager-dashboard-pulse'));
    expect(screen.getByTestId('manager-dashboard-pulse-message')).toHaveTextContent('Pulse coalesced');

    await userEvent.click(screen.getByRole('button', { name: 'Pause pulses of Lead' }));

    expect(screen.getByTestId('manager-dashboard-pulse-message')).toHaveTextContent('The daemon hit an unexpected error');
  });

  it('resumes the pulses of a paused manager from the live controls', async () => {
    const api = { updateManager: vi.fn().mockResolvedValue({}) };
    await renderDashboardOf({ ...MANAGER_VIEW, pulseEnabled: false }, api);

    await userEvent.click(screen.getByRole('button', { name: 'Resume pulses of Lead' }));

    expect(api.updateManager).toHaveBeenCalledWith('m1', { pulseEnabled: true });
  });

  it('says "Pulses paused" and shows a dash instead of counting down, and disables "Pulse now", for a paused manager', async () => {
    await renderDashboardOf({ ...MANAGER_VIEW, pulseEnabled: false });

    expect(screen.getByTestId('manager-dashboard-pulse-header')).toHaveTextContent('Pulses paused');
    expect(screen.getByTestId('manager-dashboard-countdown')).toHaveTextContent(/^\s*—\s*$/);
    expect(screen.getByRole('progressbar', { name: 'Pulses paused' })).toBeTruthy();
    expect(screen.getByTestId('manager-dashboard-pulse')).toBeDisabled();
  });

  it('tells a paused manager sends one pulse on resume, without inventing a held-wake count', async () => {
    await renderDashboardOf({ ...MANAGER_VIEW, pulseEnabled: false });

    const wakeLine = screen.getByTestId('manager-dashboard-wake');

    expect(wakeLine).toHaveTextContent('timer · child message · trigger — one pulse is sent on resume');
    expect(wakeLine).not.toHaveTextContent(/\d/);
  });

  it('keeps "Pulse now" available and shows no paused header or wake line for a running manager', async () => {
    await renderDashboardOf(MANAGER_VIEW);

    expect(screen.getByTestId('manager-dashboard-pulse')).toBeEnabled();
    expect(screen.queryByTestId('manager-dashboard-pulse-header')).toBeNull();
    expect(screen.queryByTestId('manager-dashboard-wake')).toBeNull();
    expect(screen.getByRole('progressbar', { name: 'Next pulse' })).toBeTruthy();
  });

  it('draws the pause glyph before the label of a running manager', async () => {
    await renderDashboardOf(MANAGER_VIEW);

    expect(screen.getByTestId('manager-dashboard-pause')).toHaveTextContent('❚❚ Pause pulses');
  });

  it('draws the resume glyph before the label of a paused manager', async () => {
    await renderDashboardOf({ ...MANAGER_VIEW, pulseEnabled: false });

    expect(screen.getByTestId('manager-dashboard-pause')).toHaveTextContent('▶ Resume pulses');
  });

  it('keeps the glyph out of the accessible name of the pause button', async () => {
    await renderDashboardOf({ ...MANAGER_VIEW, pulseEnabled: false });

    expect(screen.getByRole('button', { name: 'Resume pulses of Lead' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: /▶|❚/ })).toBeNull();
  });
});

describe('ManagerDashboardComponent', () => {
  it('shows the manager name, state and children cap headroom', async () => {
    const fake = fakeEvents({ sessions: [MANAGER_SESSION, CHILD_SESSION], managers: [MANAGER_VIEW] });
    await render(ManagerDashboardComponent, {
      providers: [provideRouter([]), { provide: ActivatedRoute, useValue: activatedRouteFor('m1') }, { provide: FleetEventsService, useValue: fake }, { provide: FleetApiService, useValue: governanceApi }],
    });
    expect(screen.getByTestId('manager-dashboard-name')).toHaveTextContent('Lead');
    expect(screen.getByTestId('manager-dashboard-cap')).toHaveTextContent('1/2');
  });

  it('links the log table the manager is bound to, on the project of the manager', async () => {
    const fake = fakeEvents({ sessions: [{ ...MANAGER_SESSION, projectId: 'p1' }], managers: [{ ...MANAGER_VIEW, logStoreId: 'store-log' }] });
    await render(ManagerDashboardComponent, {
      providers: [provideRouter([]), { provide: ActivatedRoute, useValue: activatedRouteFor('m1') }, { provide: FleetEventsService, useValue: fake }, { provide: FleetApiService, useValue: governanceApi }],
    });

    const link = within(screen.getByTestId('manager-dashboard-links')).getByRole('link', { name: 'Log table of Lead' });

    expect(link).toHaveAttribute('href', '/tables?projectId=p1&storeId=store-log');
  });

  it('shows no link row for a manager with neither a mission note nor a log table', async () => {
    const fake = fakeEvents({ sessions: [MANAGER_SESSION], managers: [MANAGER_VIEW] });
    await render(ManagerDashboardComponent, {
      providers: [provideRouter([]), { provide: ActivatedRoute, useValue: activatedRouteFor('m1') }, { provide: FleetEventsService, useValue: fake }, { provide: FleetApiService, useValue: governanceApi }],
    });

    expect(screen.queryByTestId('manager-dashboard-links')).toBeNull();
  });

  it('gives an unbroken long manager name a tooltip and lets it wrap instead of being clipped', async () => {
    const longName = 'A'.repeat(80);
    const fake = fakeEvents({ sessions: [{ ...MANAGER_SESSION, name: longName }], managers: [MANAGER_VIEW] });
    await render(ManagerDashboardComponent, {
      providers: [provideRouter([]), { provide: ActivatedRoute, useValue: activatedRouteFor('m1') }, { provide: FleetEventsService, useValue: fake }, { provide: FleetApiService, useValue: governanceApi }],
    });

    const name = screen.getByTestId('manager-dashboard-name');

    expect(name).toHaveAttribute('title', longName);
    expect(getComputedStyle(name).overflowWrap).toBe('anywhere');
  });

  it('user reads bidi and zero-width controls in the manager and child names as escapes, in text and tooltip', async () => {
    const fake = fakeEvents({
      sessions: [{ ...MANAGER_SESSION, name: 'Le‮ad' }, { ...CHILD_SESSION, name: 'Gim​li' }],
      managers: [MANAGER_VIEW],
    });
    await render(ManagerDashboardComponent, {
      providers: [provideRouter([]), { provide: ActivatedRoute, useValue: activatedRouteFor('m1') }, { provide: FleetEventsService, useValue: fake }, { provide: FleetApiService, useValue: governanceApi }],
    });

    const name = screen.getByTestId('manager-dashboard-name');
    expect(name).toHaveTextContent('Le<U+202E>ad');
    expect(name).toHaveAttribute('title', 'Le<U+202E>ad');
    expect(screen.getByTestId('manager-dashboard-child-c1')).toHaveTextContent('Gim<U+200B>li');
  });

  it('shows a loading state before the snapshot has arrived, instead of a blank screen', async () => {
    const fake = fakeEvents({ snapshotReceived: false });
    await render(ManagerDashboardComponent, {
      providers: [provideRouter([]), { provide: ActivatedRoute, useValue: activatedRouteFor('m1') }, { provide: FleetEventsService, useValue: fake }, { provide: FleetApiService, useValue: governanceApi }],
    });
    expect(screen.getByTestId('manager-dashboard-loading')).toBeTruthy();
    expect(screen.queryByTestId('manager-dashboard-not-found')).toBeNull();
  });

  it('shows "session not found" once the snapshot has loaded but no session matches the id', async () => {
    const fake = fakeEvents({ sessions: [], snapshotReceived: true });
    await render(ManagerDashboardComponent, {
      providers: [provideRouter([]), { provide: ActivatedRoute, useValue: activatedRouteFor('missing-id') }, { provide: FleetEventsService, useValue: fake }, { provide: FleetApiService, useValue: governanceApi }],
    });
    expect(screen.getByTestId('manager-dashboard-not-found')).toBeTruthy();
  });

  it('offers a "Back to sessions" action on "session not found", instead of a dead end', async () => {
    const fake = fakeEvents({ sessions: [], snapshotReceived: true });
    const { fixture } = await render(ManagerDashboardComponent, {
      providers: [provideRouter([]), { provide: ActivatedRoute, useValue: activatedRouteFor('missing-id') }, { provide: FleetEventsService, useValue: fake }, { provide: FleetApiService, useValue: governanceApi }],
    });
    const router = fixture.debugElement.injector.get(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    const notFound = screen.getByTestId('manager-dashboard-not-found');
    expect(notFound).toHaveTextContent('Session not found');
    await userEvent.click(screen.getByTestId('manager-dashboard-not-found-back'));

    expect(navigateSpy).toHaveBeenCalledWith(['/']);
  });

  it('shows "not a manager" instead of full manager chrome when the session at this id is not a manager', async () => {
    const plainSession = { id: 's1', name: 'Gimli', emoji: '⚔️', state: 'idle', harness: 'claude-cli' };
    const fake = fakeEvents({ sessions: [plainSession] });
    await render(ManagerDashboardComponent, {
      providers: [provideRouter([]), { provide: ActivatedRoute, useValue: activatedRouteFor('s1') }, { provide: FleetEventsService, useValue: fake }, { provide: FleetApiService, useValue: governanceApi }],
    });
    expect(screen.getByTestId('manager-dashboard-not-manager')).toBeTruthy();
    expect(screen.queryByTestId('manager-governance')).toBeNull();
  });

  it('offers to open its terminal on "not a manager", instead of a dead end', async () => {
    const plainSession = { id: 's1', name: 'Gimli', emoji: '⚔️', state: 'idle', harness: 'claude-cli' };
    const fake = fakeEvents({ sessions: [plainSession] });
    const { fixture } = await render(ManagerDashboardComponent, {
      providers: [provideRouter([]), { provide: ActivatedRoute, useValue: activatedRouteFor('s1') }, { provide: FleetEventsService, useValue: fake }, { provide: FleetApiService, useValue: governanceApi }],
    });
    const router = fixture.debugElement.injector.get(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    const notManager = screen.getByTestId('manager-dashboard-not-manager');
    expect(notManager).toHaveTextContent('This session is not a manager');
    await userEvent.click(screen.getByTestId('manager-dashboard-not-manager-terminal'));

    expect(navigateSpy).toHaveBeenCalledWith(['/session', 's1']);
  });

  it('derives the children header count from the live session list, updating immediately when a child is created', async () => {
    const staleManagerView = { ...MANAGER_VIEW, childrenCount: 0 };
    const fake = fakeEvents({ sessions: [MANAGER_SESSION], managers: [staleManagerView] });
    const { fixture } = await render(ManagerDashboardComponent, {
      providers: [provideRouter([]), { provide: ActivatedRoute, useValue: activatedRouteFor('m1') }, { provide: FleetEventsService, useValue: fake }, { provide: FleetApiService, useValue: governanceApi }],
    });
    expect(screen.getByTestId('manager-dashboard-cap')).toHaveTextContent('0/2');

    fake.sessions.set([MANAGER_SESSION, CHILD_SESSION]);
    await fixture.whenStable();

    expect(screen.getByTestId('manager-dashboard-cap')).toHaveTextContent('1/2');
  });

  describe('screen order', () => {
    const profileApi = {
      getManagerProfile: vi.fn().mockResolvedValue({ manager: MANAGER_VIEW, scapeImport: 'not_imported' }),
      listProjects: vi.fn().mockResolvedValue({ items: [] }),
    };
    const renderManager = (session: Record<string, unknown>) =>
      render(ManagerDashboardComponent, {
        providers: [
          provideRouter([]),
          { provide: ActivatedRoute, useValue: activatedRouteFor('m1') },
          { provide: FleetApiService, useValue: { ...governanceApi, ...profileApi } },
          { provide: FleetEventsService, useValue: fakeEvents({ sessions: [session, CHILD_SESSION], managers: [MANAGER_VIEW] }) },
        ],
      });
    const isBefore = (first: HTMLElement, second: HTMLElement) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

    it('user reads the profile of a live manager above its dashboard', async () => {
      const { fixture } = await renderManager(MANAGER_SESSION);
      await fixture.whenStable();

      const profile = await screen.findByRole('region', { name: 'Profile' });
      expect(isBefore(profile, screen.getByTestId('manager-dashboard-live'))).toBe(true);
      expect(screen.getByTestId('manager-dashboard-child-c1')).toBeTruthy();
    });

    it('user sees a closed manager as its profile only: no dashboard controls, no Children card, no journal notice', async () => {
      const { fixture } = await renderManager({ ...MANAGER_SESSION, state: 'closed' });
      await fixture.whenStable();

      expect(await screen.findByRole('region', { name: 'Profile' })).toBeTruthy();
      expect(screen.queryByTestId('manager-dashboard-live')).toBeNull();
      expect(screen.queryByTestId('manager-dashboard-pulse')).toBeNull();
      expect(screen.queryByTestId('manager-dashboard-terminal')).toBeNull();
      expect(screen.queryByTestId('manager-dashboard-countdown')).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Children' })).toBeNull();
      expect(screen.queryByText('Children')).toBeNull();
      expect(screen.getByRole('heading', { name: 'Governance' })).toBeVisible();
    });

    it('user can still reopen, resume or write a handoff for a closed manager', async () => {
      await renderManager({ ...MANAGER_SESSION, state: 'closed' });

      expect(screen.getByTestId('manager-dashboard-reopen')).toBeEnabled();
      expect(screen.getByTestId('manager-dashboard-resume')).toBeEnabled();
      expect(screen.getByTestId('manager-dashboard-write-handoff')).toBeEnabled();
    });
  });

  it('resets the pulse action state when the route id changes from one manager to another', async () => {
    const paramMap$ = new BehaviorSubject(convertToParamMap({ id: 'm1' }));
    const api = { pulseNow: vi.fn().mockRejectedValue(new Error('POST /api/managers/m1/pulse → 409')) };
    const managerB = { id: 'm2', name: 'Second', emoji: '🧭', role: 'manager', state: 'idle', harness: 'claude-cli' };
    const managerBView = { ...MANAGER_VIEW, sessionId: 'm2' };
    const fake = fakeEvents({ sessions: [MANAGER_SESSION, managerB], managers: [MANAGER_VIEW, managerBView] });
    const { fixture } = await render(ManagerDashboardComponent, {
      providers: [provideRouter([]), 
        { provide: ActivatedRoute, useValue: { paramMap: paramMap$ } },
        { provide: FleetApiService, useValue: { ...governanceApi, ...api } },
        { provide: FleetEventsService, useValue: fake },
      ],
    });

    await userEvent.click(screen.getByTestId('manager-dashboard-pulse'));
    expect(screen.getByTestId('manager-dashboard-pulse-message')).toBeTruthy();

    paramMap$.next(convertToParamMap({ id: 'm2' }));
    await fixture.whenStable();

    expect(screen.queryByTestId('manager-dashboard-pulse-message')).toBeNull();
  });

  describe('a reopen still in flight when the user opens another closed manager', () => {
    const closedManagerA = { ...MANAGER_SESSION, id: 'm1', state: 'closed' };
    const closedManagerB = { ...MANAGER_SESSION, id: 'm2', name: 'Second', state: 'closed' };
    const managerBView = { ...MANAGER_VIEW, sessionId: 'm2' };

    async function renderTwoClosedManagersWithHeldReopens() {
      const paramMap$ = new BehaviorSubject(convertToParamMap({ id: 'm1' }));
      const heldReopens: { sessionId: string; settle: (outcome: { rejectWith?: Error }) => void }[] = [];
      const api = {
        getManagerProfile: vi.fn().mockResolvedValue({ manager: MANAGER_VIEW, scapeImport: 'not_imported' }),
        listProjects: vi.fn().mockResolvedValue({ items: [] }),
        reopenSession: vi.fn((sessionId: string) => new Promise<void>((resolve, reject) => {
          heldReopens.push({ sessionId, settle: ({ rejectWith }) => (rejectWith ? reject(rejectWith) : resolve()) });
        })),
      };
      const view = await render(ManagerDashboardComponent, {
        providers: [
          provideRouter([]),
          { provide: ActivatedRoute, useValue: { paramMap: paramMap$ } },
          { provide: FleetApiService, useValue: { ...governanceApi, ...api } },
          { provide: FleetEventsService, useValue: fakeEvents({ sessions: [closedManagerA, closedManagerB], managers: [MANAGER_VIEW, managerBView] }) },
        ],
      });
      const heldReopenOf = (sessionId: string) => heldReopens.find((held) => held.sessionId === sessionId)!;
      const settleReopen = async (sessionId: string, outcome: { rejectWith?: Error } = {}) => {
        heldReopenOf(sessionId).settle(outcome);
        await new Promise((resolve) => setTimeout(resolve, 0));
        await view.fixture.whenStable();
      };
      const openManager = async (id: string) => {
        paramMap$.next(convertToParamMap({ id }));
        await view.fixture.whenStable();
      };
      return { api, settleReopen, openManager };
    }

    it('user still sees the second manager reopen as in progress when the first reopen completes', async () => {
      const { api, settleReopen, openManager } = await renderTwoClosedManagersWithHeldReopens();
      await userEvent.click(screen.getByTestId('manager-dashboard-reopen'));
      await openManager('m2');
      await userEvent.click(screen.getByTestId('manager-dashboard-reopen'));
      expect(api.reopenSession).toHaveBeenCalledWith('m2', expect.anything());

      await settleReopen('m1');

      expect(screen.getByTestId('manager-dashboard-reopen')).toBeDisabled();
      expect(screen.getByTestId('manager-dashboard-resume')).toBeDisabled();
    });

    it('user never reads the refusal of the first manager reopen on the second manager', async () => {
      const { settleReopen, openManager } = await renderTwoClosedManagersWithHeldReopens();
      await userEvent.click(screen.getByTestId('manager-dashboard-reopen'));
      await openManager('m2');

      await settleReopen('m1', { rejectWith: new Error('POST /api/sessions/m1/reopen → 409') });

      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('lists each child in the table with its name and state', async () => {
    const fake = fakeEvents({ sessions: [MANAGER_SESSION, CHILD_SESSION], managers: [MANAGER_VIEW] });
    await render(ManagerDashboardComponent, {
      providers: [provideRouter([]), { provide: ActivatedRoute, useValue: activatedRouteFor('m1') }, { provide: FleetEventsService, useValue: fake }, { provide: FleetApiService, useValue: governanceApi }],
    });
    const row = screen.getByTestId('manager-dashboard-child-c1');
    expect(row).toHaveTextContent('Gimli');
    expect(row).toHaveTextContent('generating');
  });

  it('pulses now when the button is clicked', async () => {
    const api = { pulseNow: vi.fn().mockResolvedValue({}) };
    const fake = fakeEvents({ sessions: [MANAGER_SESSION], managers: [MANAGER_VIEW] });
    await render(ManagerDashboardComponent, {
      providers: [provideRouter([]), 
        { provide: ActivatedRoute, useValue: activatedRouteFor('m1') },
        { provide: FleetApiService, useValue: { ...governanceApi, ...api } },
        { provide: FleetEventsService, useValue: fake },
      ],
    });

    await userEvent.click(screen.getByTestId('manager-dashboard-pulse'));

    expect(api.pulseNow).toHaveBeenCalledWith('m1');
  });

  it('shows an explicit notice instead of a silently missing journal/proposals section', async () => {
    const fake = fakeEvents({ sessions: [MANAGER_SESSION], managers: [MANAGER_VIEW] });
    await render(ManagerDashboardComponent, {
      providers: [provideRouter([]), { provide: ActivatedRoute, useValue: activatedRouteFor('m1') }, { provide: FleetEventsService, useValue: fake }, { provide: FleetApiService, useValue: governanceApi }],
    });
    expect(screen.getByRole('heading', { name: 'Governance' })).toBeVisible();
    expect(screen.queryByText(/coming/i)).toBeNull();
  });

  it('disables "Pulse now" while a pulse request is pending, so a slow response cannot be double-fired', async () => {
    let resolvePulse!: () => void;
    const api = { pulseNow: vi.fn(() => new Promise<void>((resolve) => { resolvePulse = resolve; })) };
    const fake = fakeEvents({ sessions: [MANAGER_SESSION], managers: [MANAGER_VIEW] });
    await render(ManagerDashboardComponent, {
      providers: [provideRouter([]), 
        { provide: ActivatedRoute, useValue: activatedRouteFor('m1') },
        { provide: FleetApiService, useValue: { ...governanceApi, ...api } },
        { provide: FleetEventsService, useValue: fake },
      ],
    });

    await userEvent.click(screen.getByTestId('manager-dashboard-pulse'));
    expect(screen.getByTestId('manager-dashboard-pulse')).toBeDisabled();

    resolvePulse();
  });

  it('shows an error message, not a silent failure, when the pulse request is rejected (e.g. a closed session)', async () => {
    const api = { pulseNow: vi.fn().mockRejectedValue(new Error('POST /api/managers/m1/pulse → 409')) };
    const fake = fakeEvents({ sessions: [MANAGER_SESSION], managers: [MANAGER_VIEW] });
    await render(ManagerDashboardComponent, {
      providers: [provideRouter([]), 
        { provide: ActivatedRoute, useValue: activatedRouteFor('m1') },
        { provide: FleetApiService, useValue: { ...governanceApi, ...api } },
        { provide: FleetEventsService, useValue: fake },
      ],
    });

    await userEvent.click(screen.getByTestId('manager-dashboard-pulse'));

    expect(screen.getByTestId('manager-dashboard-pulse-message')).toBeTruthy();
  });

  it('lets a keyboard-only user Tab to "Pulse now" and activate it with Enter', async () => {
    const api = { pulseNow: vi.fn().mockResolvedValue({}) };
    const fake = fakeEvents({ sessions: [MANAGER_SESSION], managers: [MANAGER_VIEW] });
    await render(ManagerDashboardComponent, {
      providers: [provideRouter([]), 
        { provide: ActivatedRoute, useValue: activatedRouteFor('m1') },
        { provide: FleetApiService, useValue: { ...governanceApi, ...api } },
        { provide: FleetEventsService, useValue: fake },
      ],
    });

    const pulseButton = screen.getByTestId('manager-dashboard-pulse');
    const maxTabStopsBeforePulse = 6;
    for (let tabStops = 0; tabStops < maxTabStopsBeforePulse && document.activeElement !== pulseButton; tabStops++) await userEvent.tab();
    expect(pulseButton).toHaveFocus();
    await userEvent.keyboard('{Enter}');

    expect(api.pulseNow).toHaveBeenCalledWith('m1');
  });

  it('shows the harness, model rung and last activity under the manager name', async () => {
    const managerSessionWithModel = { ...MANAGER_SESSION, model: 'opus', stateSince: new Date(Date.now() - 3 * 3600_000).toISOString() };
    const fake = fakeEvents({ sessions: [managerSessionWithModel], managers: [MANAGER_VIEW] });
    await render(ManagerDashboardComponent, {
      providers: [provideRouter([]), { provide: ActivatedRoute, useValue: activatedRouteFor('m1') }, { provide: FleetEventsService, useValue: fake }, { provide: FleetApiService, useValue: governanceApi }],
    });

    const meta = screen.getByTestId('manager-dashboard-meta');
    expect(meta).toHaveTextContent('claude-cli');
    expect(meta).toHaveTextContent('opus');
    expect(meta).toHaveTextContent('last activity 3 h ago');
  });

  it('opens the manager\'s own session terminal when "Terminal" is clicked', async () => {
    const fake = fakeEvents({ sessions: [MANAGER_SESSION], managers: [MANAGER_VIEW] });
    const { fixture } = await render(ManagerDashboardComponent, {
      providers: [provideRouter([]), { provide: ActivatedRoute, useValue: activatedRouteFor('m1') }, { provide: FleetEventsService, useValue: fake }, { provide: FleetApiService, useValue: governanceApi }],
    });
    const router = fixture.debugElement.injector.get(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    await userEvent.click(screen.getByTestId('manager-dashboard-terminal'));

    expect(navigateSpy).toHaveBeenCalledWith(['/session', 'm1']);
  });

  it('shows the countdown as m:ss instead of raw seconds', async () => {
    const managerView = { ...MANAGER_VIEW, nextPulseAt: new Date(Date.now() + 580_000).toISOString() };
    const fake = fakeEvents({ sessions: [MANAGER_SESSION], managers: [managerView] });
    await render(ManagerDashboardComponent, {
      providers: [provideRouter([]), { provide: ActivatedRoute, useValue: activatedRouteFor('m1') }, { provide: FleetEventsService, useValue: fake }, { provide: FleetApiService, useValue: governanceApi }],
    });
    expect(screen.getByTestId('manager-dashboard-countdown')).toHaveTextContent('9:40');
  });

  it('shows the children cap as a mini capacity meter next to the N/cap count', async () => {
    const fake = fakeEvents({ sessions: [MANAGER_SESSION, CHILD_SESSION], managers: [MANAGER_VIEW] });
    await render(ManagerDashboardComponent, {
      providers: [provideRouter([]), { provide: ActivatedRoute, useValue: activatedRouteFor('m1') }, { provide: FleetEventsService, useValue: fake }, { provide: FleetApiService, useValue: governanceApi }],
    });

    const meter = screen.getByRole('meter', { name: /1 of 2 children/i });
    expect(meter).toBeTruthy();
  });
});
