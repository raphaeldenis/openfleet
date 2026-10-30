import { render, screen } from '@testing-library/angular/zoneless';
import { inputBinding, signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@openfleet/shared';
import { SessionDetailsComponent } from './session-details.component';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

const ATTENDED_TEXT = 'Yes - you sit beside this manager';
const SUPERVISED_TEXT = 'No - supervised: its questions go through the escalation ladder';

function baseSession(patch: Partial<Session> = {}): Session {
  return {
    id: 's1', name: 'Lead', emoji: '🧭', directory: '/repo', model: 'claude-sonnet-5',
    harness: 'claude-cli', state: 'idle', stateSince: '2026-09-26T10:00:00.000Z', permissionMode: 'manual',
    createdAt: '2026-09-26T09:00:00.000Z', ...patch,
  } as Session;
}

async function renderDetails(session: Session | ReturnType<typeof signal<Session>>) {
  const current = typeof (session as { set?: unknown }).set === 'function' ? (session as ReturnType<typeof signal<Session>>) : signal(session as Session);
  const api = { updateModel: vi.fn(), closeSession: vi.fn(), sendInput: vi.fn(), renameSession: vi.fn() };
  await render(SessionDetailsComponent, {
    bindings: [inputBinding('session', current)],
    providers: [
      { provide: FleetApiService, useValue: api },
      { provide: FleetEventsService, useValue: { sessions: signal([current()]), approvals: signal([]), managers: signal([]), connected: signal(true) } },
    ],
  });
}

describe('SessionDetailsComponent attended row', () => {
  beforeEach(() => localStorage.clear());

  it('tells the operator they sit beside an attended manager', async () => {
    await renderDetails(baseSession({ role: 'manager', attended: true }));

    expect(screen.getByTestId('session-attended')).toHaveTextContent(ATTENDED_TEXT);
    expect(screen.getByText('Attended')).toBeTruthy();
  });

  it('tells the operator a manager without the flag is supervised', async () => {
    await renderDetails(baseSession({ role: 'manager' }));

    expect(screen.getByTestId('session-attended')).toHaveTextContent(SUPERVISED_TEXT);
  });

  it('shows no attended row on a session that is not a manager', async () => {
    await renderDetails(baseSession({ role: 'dev' }));

    expect(screen.queryByTestId('session-attended')).toBeNull();
  });

  it('shows no attended row on a session without a role', async () => {
    await renderDetails(baseSession());

    expect(screen.queryByTestId('session-attended')).toBeNull();
  });

  it('offers no control to change the attended flag', async () => {
    await renderDetails(baseSession({ role: 'manager', attended: true }));

    const row = screen.getByTestId('session-attended').closest('.fact') as HTMLElement;
    expect(row.querySelector('input, button, select, [tabindex]')).toBeNull();
  });

  it('updates the row when the attended flag of the card changes', async () => {
    const current = signal<Session>(baseSession({ role: 'manager' }));
    await renderDetails(current);
    expect(screen.getByTestId('session-attended')).toHaveTextContent(SUPERVISED_TEXT);

    current.set(baseSession({ role: 'manager', attended: true }));

    expect(await screen.findByText(ATTENDED_TEXT)).toBe(screen.getByTestId('session-attended'));
  });
});
