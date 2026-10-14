import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import type { GovernanceProposalView, ManagerView } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { fakeWorkingStateEvents, sessionOf } from '../working-state/working-state-fixtures';
import { InboxComponent } from './inbox.component';

const proposal = (id: string): GovernanceProposalView => ({
  id, managerId: 'm1', kind: 'law', status: 'pending', incident: `Incident of ${id}`, payload: { text: `Law ${id}` }, createdAt: new Date().toISOString(),
});

const approval = { id: 'a1', sessionId: 'm1', toolName: 'Bash', toolInput: {}, status: 'pending', createdAt: 't' };

async function renderInbox({ proposals = [] as GovernanceProposalView[], approvals = [] as unknown[] } = {}) {
  const manager = sessionOf({ id: 'm1', name: 'Lloyd', role: 'manager' });
  const events = { ...fakeWorkingStateEvents({ sessions: [manager] }), approvals: signal(approvals), proposals: signal(proposals), managers: signal<ManagerView[]>([]) };
  const api = { decide: vi.fn(), decideProposal: vi.fn().mockResolvedValue({}) };
  await render(InboxComponent, { providers: [provideRouter([]), { provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: events }] });
  return { events, api };
}

describe('InboxComponent governance proposals', () => {
  it('user sees a pending proposal with its incident, and the Inbox count rises by one', async () => {
    await renderInbox({ proposals: [proposal('p1')] });

    expect(screen.getByText('Incident of p1')).toBeVisible();
    expect(screen.getByTestId('inbox-count')).toHaveTextContent('1');
  });

  it('user sees pending proposals add up with the approvals in the Inbox count', async () => {
    await renderInbox({ proposals: [proposal('p1'), proposal('p2')], approvals: [approval] });

    expect(screen.getByTestId('inbox-count')).toHaveTextContent('3');
    expect(screen.getByTestId('inbox-count')).toHaveAccessibleName('3 items need you');
  });

  it('user sees the Governance filter hold only the proposals', async () => {
    await renderInbox({ proposals: [proposal('p1')], approvals: [approval] });

    await userEvent.click(screen.getByTestId('inbox-filter-governance'));

    expect(screen.getByTestId('inbox-filter-governance')).toHaveTextContent('1');
    expect(screen.getByText('Incident of p1')).toBeVisible();
    expect(screen.queryByTestId('inbox-gate-card')).toBeNull();
  });

  it('user sees the count fall and the card leave once a proposal is approved', async () => {
    await renderInbox({ proposals: [proposal('p1'), proposal('p2')] });

    await userEvent.click(screen.getAllByRole('button', { name: 'Approve proposal from Lloyd' })[0]);

    await waitFor(() => expect(screen.getByTestId('inbox-count')).toHaveTextContent('1'));
    expect(screen.queryByText('Incident of p1')).toBeNull();
  });

  it('user sees the empty state when nothing is pending', async () => {
    await renderInbox();

    expect(screen.getByTestId('inbox-empty')).toBeVisible();
    expect(screen.queryByTestId('inbox-count')).toBeNull();
  });
});
