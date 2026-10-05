import { Component, signal } from '@angular/core';
import { provideRouter, Router } from '@angular/router';
import { render, screen } from '@testing-library/angular/zoneless';
import { describe, expect, it } from 'vitest';
import { FleetEventsService } from '../core/fleet-events.service';
import { SessionListComponent } from './session-list.component';

@Component({ selector: 'test-page', template: '' })
class PageComponent {}

const gimli = { id: 'c1', name: 'Gimli', emoji: '⚔️', state: 'idle' };
const legolas = { id: 'c2', name: 'Legolas', emoji: '🏹', state: 'generating' };

async function renderListAt(url: string) {
  const events = {
    sessions: signal([gimli, legolas]),
    approvals: signal([]),
    managers: signal([]),
    workingStates: signal(new Map()),
    workingStatesReported: signal(false),
    workingStateMaxAgeMinutes: signal<number | undefined>(30),
    workingStateMaxBytes: signal<number | undefined>(6144),
  };
  const { fixture } = await render(SessionListComponent, {
    providers: [provideRouter([{ path: 'session/:id', component: PageComponent }, { path: 'inbox', component: PageComponent }]), { provide: FleetEventsService, useValue: events }],
  });
  const router = fixture.debugElement.injector.get(Router);
  await router.navigateByUrl(url);
  return { router };
}

const isSelected = (sessionId: string) => screen.getByTestId(`session-${sessionId}`).getAttribute('aria-current') === 'true';

describe('SessionListComponent selection', () => {
  it('user sees the session of the open route marked as the current one, and only that one', async () => {
    await renderListAt('/session/c1');

    await expect.poll(() => isSelected('c1')).toBe(true);
    expect(isSelected('c2')).toBe(false);
  });

  it('user sees the mark follow them to another session', async () => {
    const { router } = await renderListAt('/session/c1');
    await expect.poll(() => isSelected('c1')).toBe(true);

    await router.navigateByUrl('/session/c2');

    await expect.poll(() => isSelected('c2')).toBe(true);
    expect(isSelected('c1')).toBe(false);
  });

  it('user sees no row marked while a page without a session is open', async () => {
    const { router } = await renderListAt('/session/c1');
    await expect.poll(() => isSelected('c1')).toBe(true);

    await router.navigateByUrl('/inbox');

    await expect.poll(() => isSelected('c1')).toBe(false);
    expect(isSelected('c2')).toBe(false);
  });
});
