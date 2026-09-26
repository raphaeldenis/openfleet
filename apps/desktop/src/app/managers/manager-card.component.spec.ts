import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { ManagerView } from '@openfleet/shared';
import { ManagerCardComponent } from './manager-card.component';
import { FleetApiService, ApiError } from '../core/fleet-api.service';

function manager(patch: Partial<ManagerView> = {}): ManagerView {
  return {
    sessionId: 'm1',
    pulseSeconds: 1800,
    childrenCap: 2,
    missionText: 'x',
    nextPulseAt: new Date(Date.now() + 42_000).toISOString(),
    childrenCount: 1,
    ...patch,
  };
}

describe('ManagerCardComponent', () => {
  it('shows children count over cap', async () => {
    await render(ManagerCardComponent, { bindings: [inputBinding('manager', () => manager({ childrenCount: 1, childrenCap: 2 }))] });
    expect(screen.getByTestId('manager-m1-children')).toHaveTextContent('1/2');
  });

  it('shows a live countdown to the next pulse', async () => {
    await render(ManagerCardComponent, { bindings: [inputBinding('manager', () => manager())] });
    expect(screen.getByTestId('manager-m1-countdown').textContent).toMatch(/\d+s/);
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

    expect(screen.getByTestId('manager-m1-countdown')).toHaveTextContent('0s');
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

  it('cleans up its 1s countdown ticker on destroy, leaving no dangling timer', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const { fixture } = await render(ManagerCardComponent, { bindings: [inputBinding('manager', () => manager())] });
    const createdTimer = setIntervalSpy.mock.results.at(-1)?.value;

    fixture.destroy();

    expect(clearIntervalSpy).toHaveBeenCalledWith(createdTimer);
  });
});
