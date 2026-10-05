import { Component, signal } from '@angular/core';
import { provideRouter, Router } from '@angular/router';
import { render, screen } from '@testing-library/angular/zoneless';
import { describe, expect, it } from 'vitest';
import { FleetEventsService } from '../core/fleet-events.service';
import { ManagerGroupComponent } from './manager-group.component';

@Component({ selector: 'test-page', template: '' })
class PageComponent {}

const capitaine = { id: 'm1', name: 'Capitaine', emoji: '🧭', role: 'manager', state: 'idle' };
const forge = { id: 'm2', name: 'Forge', emoji: '🔨', role: 'manager', state: 'idle' };

async function renderGroupAt(url: string) {
  const events = { sessions: signal([capitaine, forge]), managers: signal([]) };
  const { fixture } = await render(ManagerGroupComponent, {
    providers: [provideRouter([{ path: 'manager/:id', component: PageComponent }, { path: 'inbox', component: PageComponent }]), { provide: FleetEventsService, useValue: events }],
  });
  const router = fixture.debugElement.injector.get(Router);
  await router.navigateByUrl(url);
  return { router };
}

const isSelected = (managerId: string) => screen.getByTestId(`manager-row-${managerId}`).getAttribute('aria-current') === 'true';

describe('ManagerGroupComponent selection', () => {
  it('user sees the manager of the open route marked as the current one, and only that one', async () => {
    await renderGroupAt('/manager/m1');

    await expect.poll(() => isSelected('m1')).toBe(true);
    expect(isSelected('m2')).toBe(false);
  });

  it('user sees the mark leave the manager when they open a page without one', async () => {
    const { router } = await renderGroupAt('/manager/m1');
    await expect.poll(() => isSelected('m1')).toBe(true);

    await router.navigateByUrl('/inbox');

    await expect.poll(() => isSelected('m1')).toBe(false);
  });
});
