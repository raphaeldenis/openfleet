import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { signal } from '@angular/core';
import { provideRouter, Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { ManagerGroupComponent } from './manager-group.component';
import { FleetEventsService } from '../core/fleet-events.service';

const capitaine = { id: 'm1', name: 'Capitaine', emoji: '🧭', role: 'manager', state: 'closed' };
const forge = { id: 'm2', name: 'Forge', emoji: '🔨', role: 'manager', state: 'idle' };
const child = { id: 'c1', name: 'Gimli', emoji: '⚔️', parentId: 'm2', state: 'generating' };

function managerView(sessionId: string, overrides: Record<string, unknown> = {}) {
  return { sessionId, pulseSeconds: 1800, childrenCap: 4, missionText: 'x', nextPulseAt: new Date(Date.now() + 600_000).toISOString(), childrenCount: 0, ...overrides };
}

async function renderGroup(sessions: unknown[], managers: unknown[]) {
  const events = { sessions: signal(sessions), managers: signal(managers) };
  const { fixture } = await render(ManagerGroupComponent, { providers: [provideRouter([]), { provide: FleetEventsService, useValue: events }] });
  return { events, router: fixture.debugElement.injector.get(Router) };
}

describe('ManagerGroupComponent', () => {
  it('user sees the heading "Managers"', async () => {
    await renderGroup([forge], [managerView('m2')]);

    expect(screen.getByRole('heading', { name: 'Managers' })).toBeTruthy();
  });

  it('user sees every manager, a closed one included', async () => {
    await renderGroup([capitaine, forge], [managerView('m1'), managerView('m2')]);

    expect(screen.getByTestId('manager-row-m1')).toHaveTextContent('Capitaine');
    expect(screen.getByTestId('manager-row-m2')).toHaveTextContent('Forge');
  });

  it('user sees the state of each manager as a chip', async () => {
    await renderGroup([capitaine, forge], [managerView('m1'), managerView('m2')]);

    expect(within(screen.getByTestId('manager-row-m1')).getByTestId('state-chip')).toHaveAttribute('data-state', 'closed');
    expect(within(screen.getByTestId('manager-row-m2')).getByTestId('state-chip')).toHaveAttribute('data-state', 'idle');
  });

  it('user sees the children count out of the cap', async () => {
    await renderGroup([forge, child], [managerView('m2', { childrenCount: 2, childrenCap: 4 })]);

    expect(within(screen.getByTestId('manager-row-m2')).getByTestId('manager-row-m2-children')).toHaveTextContent('2/4');
  });

  it('user sees the next pulse countdown of an open manager and "closed" for a closed one', async () => {
    await renderGroup([capitaine, forge], [managerView('m1'), managerView('m2')]);

    expect(within(screen.getByTestId('manager-row-m1')).getByTestId('manager-row-m1-countdown')).toHaveTextContent('closed');
    expect(within(screen.getByTestId('manager-row-m2')).getByTestId('manager-row-m2-countdown')).not.toHaveTextContent('closed');
  });

  it('user opens the manager dashboard by clicking a closed manager', async () => {
    const { router } = await renderGroup([capitaine], [managerView('m1')]);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    await userEvent.click(screen.getByRole('button', { name: 'Capitaine — closed' }));

    expect(navigate).toHaveBeenCalledWith(['/manager', 'm1']);
  });

  it('user sees a manager whose view has not arrived yet, without count or countdown', async () => {
    await renderGroup([forge], []);

    expect(screen.getByTestId('manager-row-m2')).toHaveTextContent('Forge');
    expect(screen.queryByTestId('manager-row-m2-children')).toBeNull();
  });

  it('user sees "No managers yet" when there is none', async () => {
    await renderGroup([{ id: 's', name: 'Plain', emoji: '🤖', state: 'idle' }], []);

    expect(screen.getByText('No managers yet')).toBeTruthy();
  });
});
