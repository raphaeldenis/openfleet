import { inputBinding, signal } from '@angular/core';
import { render, screen } from '@testing-library/angular/zoneless';
import { describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { fakeWorkingStateEvents, sessionOf, stateOf } from '../working-state/working-state-fixtures';
import { SessionTabComponent } from './session-tab.component';

const connectedDaemon = () => ({ connected: signal(true), reconnectCount: signal(0), deliveredMessageIds: signal(new Set<string>()) });

async function renderTab(sessionId: string | undefined) {
  const events = { ...connectedDaemon(), ...fakeWorkingStateEvents({ sessions: [sessionOf({ id: 's1', name: 'Gimli' })], states: [stateOf({ plan: ['ship it'] })] }) };
  const view = await render(SessionTabComponent, {
    bindings: [inputBinding('sessionId', () => sessionId)],
    providers: [{ provide: FleetApiService, useValue: {} }, { provide: FleetEventsService, useValue: events }],
  });
  return { ...view, events };
}

describe('SessionTabComponent', () => {
  it('shows the identity of the session, then its State, with the sections readable without any click', async () => {
    await renderTab('s1');

    expect((screen.getByTestId('session-name-input') as HTMLInputElement).value).toBe('Gimli');
    expect(screen.getByTestId('state-panel')).toBeTruthy();
    expect(screen.getByTestId('state-section-plan')).toHaveTextContent('ship it');
    expect(screen.queryByTestId('state-panel-toggle')).toBeNull();
  });

  it('asks to select a session when none is watched', async () => {
    await renderTab(undefined);

    expect(screen.getByTestId('session-tab-no-session')).toHaveTextContent('Select a session');
    expect(screen.queryByTestId('state-panel')).toBeNull();
  });

  it('asks to select a session when the watched id matches no session', async () => {
    await renderTab('ghost');

    expect(screen.getByTestId('session-tab-no-session')).toBeTruthy();
  });

  it('follows the watched session to another one', async () => {
    const watched = signal<string | undefined>('s1');
    const events = {
      ...connectedDaemon(),
      ...fakeWorkingStateEvents({
        sessions: [sessionOf({ id: 's1', name: 'Gimli' }), sessionOf({ id: 's2', name: 'Legolas' })],
        states: [stateOf({ sessionId: 's1', plan: ['first plan'] }), stateOf({ sessionId: 's2', plan: ['second plan'] })],
      }),
    };
    const { fixture } = await render(SessionTabComponent, {
      bindings: [inputBinding('sessionId', watched)],
      providers: [{ provide: FleetApiService, useValue: {} }, { provide: FleetEventsService, useValue: events }],
    });

    watched.set('s2');
    await fixture.whenStable();

    await vi.waitFor(() => expect((screen.getByTestId('session-name-input') as HTMLInputElement).value).toBe('Legolas'));
    expect(screen.getByTestId('state-section-plan')).toHaveTextContent('second plan');
  });
});
