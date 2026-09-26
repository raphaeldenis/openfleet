import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { ManagerView } from '@openfleet/shared';
import { ManagerCardComponent } from './manager-card.component';
import { FleetApiService } from '../core/fleet-api.service';

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
});
