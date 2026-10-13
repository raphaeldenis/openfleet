import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding } from '@angular/core';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import type { ManagerView, Session } from '@openfleet/shared';
import { ManagerCardComponent } from './manager-card.component';
import { FleetApiService, ApiError } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { fakeWorkingStateEvents } from '../working-state/working-state-fixtures';

function manager(patch: Partial<ManagerView> = {}): ManagerView {
  return {
    sessionId: 'm1',
    pulseSeconds: 1800,
    pulseEnabled: true,
    childrenCap: 2,
    missionText: 'x',
    nextPulseAt: new Date(Date.now() + 42_000).toISOString(),
    childrenCount: 1,
    ...patch,
  };
}

function session(patch: Partial<Session> = {}): Session {
  return {
    id: 'm1',
    name: 'Lead',
    emoji: '🧭',
    directory: '/tmp/wt',
    role: 'manager',
    harness: 'claude-cli',
    state: 'idle',
    stateSince: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    ...patch,
  };
}

describe('ManagerCardComponent state overdue chip', () => {
  const renderCard = (events: ReturnType<typeof fakeWorkingStateEvents>, managerSession: Session | undefined) =>
    render(ManagerCardComponent, {
      bindings: [inputBinding('manager', () => manager()), inputBinding('session', () => managerSession)],
      providers: [{ provide: FleetEventsService, useValue: events }],
    });

  it('user sees "state overdue" on the manager card when the manager has no state', async () => {
    await renderCard(fakeWorkingStateEvents({ sessions: [session()] }), session());

    expect(within(screen.getByTestId('manager-m1-card')).getByTestId('overdue-chip')).toBeTruthy();
  });

  it('user can still read the counters and reach "Pulse now" next to the chip', async () => {
    await renderCard(fakeWorkingStateEvents({ sessions: [session()] }), session());
    const card = screen.getByTestId('manager-m1-card');

    expect(within(card).getByTestId('overdue-chip')).toBeTruthy();
    expect(within(card).getByTestId('manager-m1-children')).toBeVisible();
    expect(within(card).getByTestId('manager-m1-countdown')).toBeVisible();
    screen.getByTestId('manager-m1-pulse').focus();
    expect(screen.getByTestId('manager-m1-pulse')).toHaveFocus();
  });

  it('user sees no chip on the card of a closed manager', async () => {
    await renderCard(fakeWorkingStateEvents({ sessions: [session({ state: 'closed' })] }), session({ state: 'closed' }));

    expect(screen.queryByTestId('overdue-chip')).toBeNull();
  });

  it('user sees no chip on a card that has no session to judge', async () => {
    await renderCard(fakeWorkingStateEvents({ sessions: [] }), undefined);

    expect(screen.queryByTestId('overdue-chip')).toBeNull();
  });
});

describe('ManagerCardComponent links', () => {
  it('links the log table the manager is bound to, on the project of the manager', async () => {
    await render(ManagerCardComponent, {
      providers: [provideRouter([])],
      bindings: [inputBinding('manager', () => manager({ logStoreId: 'store-log' })), inputBinding('session', () => session({ projectId: 'p1' }))],
    });

    const link = within(screen.getByTestId('manager-m1-card')).getByRole('link', { name: 'Log table of Lead' });

    expect(link).toHaveAttribute('href', '/tables?projectId=p1&storeId=store-log');
  });

  it('names the manager in the accessible name of its mission note link, whose visible text stays short', async () => {
    await render(ManagerCardComponent, {
      providers: [provideRouter([])],
      bindings: [inputBinding('manager', () => manager({ missionNoteId: 'note-mission' })), inputBinding('session', () => session({ projectId: 'p1' }))],
    });

    const link = within(screen.getByTestId('manager-m1-card')).getByRole('link', { name: 'Mission note of Lead' });

    expect(link).toHaveTextContent(/^Mission note$/);
  });

  it('shows no link for a manager that is bound to no table and has no mission note', async () => {
    await render(ManagerCardComponent, { bindings: [inputBinding('manager', () => manager())] });

    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('ManagerCardComponent pause control', () => {
  const renderCard = (managerPatch: Partial<ManagerView>, api: Partial<Record<'updateManager' | 'pulseNow', unknown>> = {}, managerSession?: Session) =>
    render(ManagerCardComponent, {
      bindings: [inputBinding('manager', () => manager(managerPatch)), inputBinding('session', () => managerSession)],
      providers: [provideRouter([]), { provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: fakeWorkingStateEvents({ sessions: managerSession ? [managerSession] : [] }) }],
    });

  it('offers to pause the pulses of a running manager and asks the daemon to pause them', async () => {
    const api = { updateManager: vi.fn().mockResolvedValue({}) };
    await renderCard({ pulseEnabled: true }, api);

    await userEvent.click(screen.getByRole('button', { name: 'Pause pulses' }));

    expect(api.updateManager).toHaveBeenCalledWith('m1', { pulseEnabled: false });
  });

  it('offers to resume the pulses of a paused manager and asks the daemon to resume them', async () => {
    const api = { updateManager: vi.fn().mockResolvedValue({}) };
    await renderCard({ pulseEnabled: false }, api);

    await userEvent.click(screen.getByRole('button', { name: 'Resume pulses' }));

    expect(api.updateManager).toHaveBeenCalledWith('m1', { pulseEnabled: true });
  });

  it('says "Pulses paused" and shows a dash instead of counting down, and disables "Pulse now", for a paused manager', async () => {
    await renderCard({ pulseEnabled: false });

    expect(screen.getByTestId('manager-m1-pulse-header')).toHaveTextContent('Pulses paused');
    expect(screen.getByTestId('manager-m1-countdown')).toHaveTextContent(/^\s*—\s*$/);
    expect(screen.getByRole('progressbar', { name: 'Pulses paused' })).toBeTruthy();
    expect(screen.getByTestId('manager-m1-pulse')).toBeDisabled();
  });

  it('keeps counting down and "Pulse now" available for a running manager', async () => {
    await renderCard({ pulseEnabled: true });

    expect(screen.queryByTestId('manager-m1-pulse-header')).toBeNull();
    expect(screen.getByRole('progressbar', { name: 'Next pulse' })).toBeTruthy();
    expect(screen.getByTestId('manager-m1-countdown')).not.toHaveTextContent('—');
    expect(screen.getByTestId('manager-m1-pulse')).toBeEnabled();
  });

  it('draws the pause glyph before the label of a running manager', async () => {
    await renderCard({ pulseEnabled: true });

    expect(screen.getByTestId('manager-m1-pause')).toHaveTextContent('❚❚ Pause pulses');
  });

  it('draws the resume glyph before the label of a paused manager', async () => {
    await renderCard({ pulseEnabled: false });

    expect(screen.getByTestId('manager-m1-pause')).toHaveTextContent('▶ Resume pulses');
  });

  it('keeps the glyph out of the accessible name of the pause button', async () => {
    await renderCard({ pulseEnabled: false }, {}, session());

    expect(screen.getByRole('button', { name: 'Resume pulses of Lead' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: /▶|❚/ })).toBeNull();
  });

  it('tells the manager is paused, not that its session is closed, when the daemon refuses a pulse because of the pause', async () => {
    const api = { pulseNow: vi.fn().mockRejectedValue(new ApiError(409, 'POST /api/managers/m1/pulse → 409', 'manager_paused')) };
    await renderCard({ pulseEnabled: true }, api);

    await userEvent.click(screen.getByTestId('manager-m1-pulse'));

    expect(screen.getByTestId('manager-m1-pulse-message')).toHaveTextContent(/paused/i);
  });

  it('names the manager in the accessible name of the pause button and tells whether the pulses are paused', async () => {
    await renderCard({ pulseEnabled: true }, {}, session());

    const pauseButton = screen.getByRole('button', { name: 'Pause pulses of Lead' });

    expect(pauseButton).toHaveAttribute('aria-pressed', 'false');
  });

  it('names the manager in the accessible name of the resume button and tells that the pulses are paused', async () => {
    await renderCard({ pulseEnabled: false }, {}, session());

    const resumeButton = screen.getByRole('button', { name: 'Resume pulses of Lead' });

    expect(resumeButton).toHaveAttribute('aria-pressed', 'true');
  });

  it('disables the pause button of a closed session', async () => {
    await renderCard({ pulseEnabled: true }, {}, session({ state: 'closed' }));

    expect(screen.getByTestId('manager-m1-pause')).toBeDisabled();
  });

  it('says the manager no longer exists when the daemon cannot find the manager to pause', async () => {
    const api = { updateManager: vi.fn().mockRejectedValue(new ApiError(404, 'PATCH /api/managers/m1 → 404', 'manager_not_found')) };
    await renderCard({ pulseEnabled: true }, api);

    await userEvent.click(screen.getByRole('button', { name: 'Pause pulses' }));

    expect(screen.getByTestId('manager-m1-pulse-message')).toHaveTextContent('That manager no longer exists');
  });

  it('tells the daemon failed, not that the connection is down, and lets the user pause again, when the daemon answers 500', async () => {
    const api = { updateManager: vi.fn().mockRejectedValue(new ApiError(500, 'PATCH /api/managers/m1 → 500', 'internal_error')) };
    await renderCard({ pulseEnabled: true }, api);

    await userEvent.click(screen.getByRole('button', { name: 'Pause pulses' }));

    expect(screen.getByTestId('manager-m1-pulse-message')).toHaveTextContent('The daemon hit an unexpected error');
    expect(screen.getByRole('button', { name: 'Pause pulses' })).toBeEnabled();
  });

  it('tells the daemon cannot be reached when the request does not get through', async () => {
    const api = { updateManager: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) };
    await renderCard({ pulseEnabled: true }, api);

    await userEvent.click(screen.getByRole('button', { name: 'Pause pulses' }));

    expect(screen.getByTestId('manager-m1-pulse-message')).toHaveTextContent('check your connection');
  });

  it('shows the pause error instead of the message left by an earlier pulse', async () => {
    const api = {
      pulseNow: vi.fn().mockResolvedValue({ coalesced: true }),
      updateManager: vi.fn().mockRejectedValue(new ApiError(500, 'PATCH /api/managers/m1 → 500', 'internal_error')),
    };
    await renderCard({ pulseEnabled: true }, api);
    await userEvent.click(screen.getByTestId('manager-m1-pulse'));
    expect(screen.getByTestId('manager-m1-pulse-message')).toHaveTextContent('Pulse coalesced');

    await userEvent.click(screen.getByRole('button', { name: 'Pause pulses' }));

    expect(screen.getByTestId('manager-m1-pulse-message')).toHaveTextContent('The daemon hit an unexpected error');
  });
});

describe('ManagerCardComponent', () => {
  it('shows children count over cap', async () => {
    await render(ManagerCardComponent, { bindings: [inputBinding('manager', () => manager({ childrenCount: 1, childrenCap: 2 }))] });
    expect(screen.getByTestId('manager-m1-children')).toHaveTextContent('1/2');
  });

  it('shows the countdown as m:ss instead of raw seconds', async () => {
    const nextPulseAt = new Date(Date.now() + 580_000).toISOString();
    await render(ManagerCardComponent, { bindings: [inputBinding('manager', () => manager({ nextPulseAt }))] });
    expect(screen.getByTestId('manager-m1-countdown')).toHaveTextContent('9:40');
  });

  it('shows a live countdown to the next pulse that advances as time passes, not a value frozen at render', async () => {
    // Fake only the ticker's own timers — leave setTimeout/rAF real so Angular's zoneless scheduler can still flush.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const { fixture } = await render(ManagerCardComponent, {
        bindings: [inputBinding('manager', () => manager({ nextPulseAt: new Date(Date.now() + 42_000).toISOString() }))],
      });
      const before = screen.getByTestId('manager-m1-countdown').textContent;

      await vi.advanceTimersByTimeAsync(5000);
      await fixture.whenStable();

      expect(screen.getByTestId('manager-m1-countdown').textContent).not.toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the pulse-ring progress indicator', async () => {
    await render(ManagerCardComponent, { bindings: [inputBinding('manager', () => manager())] });
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('calls pulseNow with the manager session id when "Pulse now" is clicked', async () => {
    const api = { pulseNow: vi.fn().mockResolvedValue({}) };
    await render(ManagerCardComponent, {
      bindings: [inputBinding('manager', () => manager({ sessionId: 'm1' }))],
      providers: [{ provide: FleetApiService, useValue: api }],
    });

    await userEvent.click(screen.getByTestId('manager-m1-pulse'));

    expect(api.pulseNow).toHaveBeenCalledWith('m1');
  });

  it('clamps the countdown to 0 when nextPulseAt has already passed, instead of showing a negative number', async () => {
    const pastPulseAt = new Date(Date.now() - 10_000).toISOString();
    await render(ManagerCardComponent, { bindings: [inputBinding('manager', () => manager({ nextPulseAt: pastPulseAt }))] });

    expect(screen.getByTestId('manager-m1-countdown')).toHaveTextContent('0:00');
  });

  it('does not render "NaNs" when nextPulseAt is an unparsable value from a malformed server payload', async () => {
    await render(ManagerCardComponent, { bindings: [inputBinding('manager', () => manager({ nextPulseAt: 'not-a-date' }))] });

    expect(screen.getByTestId('manager-m1-countdown')).not.toHaveTextContent('NaN');
  });

  it('disables "Pulse now" while a pulse request is pending, so a slow response cannot be double-fired', async () => {
    let resolvePulse!: () => void;
    const api = { pulseNow: vi.fn(() => new Promise<void>((resolve) => { resolvePulse = resolve; })) };
    await render(ManagerCardComponent, {
      bindings: [inputBinding('manager', () => manager({ sessionId: 'm1' }))],
      providers: [{ provide: FleetApiService, useValue: api }],
    });

    await userEvent.click(screen.getByTestId('manager-m1-pulse'));
    expect(screen.getByTestId('manager-m1-pulse')).toBeDisabled();

    resolvePulse();
  });

  it.each([
    ['a closed session', () => Promise.reject(new ApiError(409, 'POST /api/managers/m1/pulse → 409'))],
    ['an unknown manager', () => Promise.reject(new ApiError(404, 'POST /api/managers/m1/pulse → 404'))],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('shows an error message, not a silent failure, when pulsing fails on %s', async (_label, rejection) => {
    const api = { pulseNow: vi.fn(rejection) };
    await render(ManagerCardComponent, {
      bindings: [inputBinding('manager', () => manager({ sessionId: 'm1' }))],
      providers: [{ provide: FleetApiService, useValue: api }],
    });

    await userEvent.click(screen.getByTestId('manager-m1-pulse'));

    expect(screen.getByTestId('manager-m1-pulse-message')).toBeTruthy();
  });

  it('shows its own message when the server coalesces the pulse instead of firing it early', async () => {
    const api = { pulseNow: vi.fn().mockResolvedValue({ pulsed: false, coalesced: true }) };
    await render(ManagerCardComponent, {
      bindings: [inputBinding('manager', () => manager({ sessionId: 'm1' }))],
      providers: [{ provide: FleetApiService, useValue: api }],
    });

    await userEvent.click(screen.getByTestId('manager-m1-pulse'));

    expect(screen.getByTestId('manager-m1-pulse-message')).toHaveTextContent(/coalesc/i);
  });

  it('lets a keyboard-only user Tab to "Pulse now" and activate it with Enter', async () => {
    const api = { pulseNow: vi.fn().mockResolvedValue({}) };
    await render(ManagerCardComponent, {
      bindings: [inputBinding('manager', () => manager({ sessionId: 'm1' }))],
      providers: [{ provide: FleetApiService, useValue: api }],
    });

    await userEvent.tab();
    expect(screen.getByTestId('manager-m1-pulse')).toHaveFocus();
    await userEvent.keyboard('{Enter}');

    expect(api.pulseNow).toHaveBeenCalledWith('m1');
  });

  it('stops the countdown and disables "Pulse now", with a reason, once its session is closed', async () => {
    await render(ManagerCardComponent, {
      bindings: [inputBinding('manager', () => manager()), inputBinding('session', () => session({ state: 'closed' }))],
    });

    expect(screen.getByTestId('manager-m1-countdown')).toHaveTextContent(/closed|—/i);
    expect(screen.getByTestId('manager-m1-pulse')).toBeDisabled();
    expect(screen.getByTestId('manager-m1-pulse-message')).toHaveTextContent(/closed/i);
  });

  it('cleans up its 1s countdown ticker on destroy, leaving no dangling timer', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const { fixture } = await render(ManagerCardComponent, { bindings: [inputBinding('manager', () => manager())] });
    const createdTimer = setIntervalSpy.mock.results.at(-1)?.value;

    fixture.destroy();

    expect(clearIntervalSpy).toHaveBeenCalledWith(createdTimer);
  });
});
