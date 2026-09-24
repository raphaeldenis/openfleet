import { render, screen } from '@testing-library/angular/zoneless';
import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { SessionListComponent } from './session-list.component';
import { FleetEventsService } from '../core/fleet-events.service';

describe('SessionListComponent', () => {
  it('renders each session with its emoji, name and state', async () => {
    const fake = { sessions: signal([{ id: '1', name: 'Gimli', emoji: '⚔️', state: 'generating' }]), approvals: signal([]) };
    await render(SessionListComponent, { providers: [{ provide: FleetEventsService, useValue: fake }] });
    expect(screen.getByText('⚔️ Gimli')).toBeTruthy();
    expect(screen.getByText('generating')).toBeTruthy();
  });
});
