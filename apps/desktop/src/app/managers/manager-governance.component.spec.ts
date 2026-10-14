import { render, screen, waitFor, within } from '@testing-library/angular/zoneless';
import { inputBinding, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import type { GovernanceProposalView, ManagerGovernanceView } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { ManagerGovernanceComponent } from './manager-governance.component';

const proposal = (patch: Partial<GovernanceProposalView>): GovernanceProposalView => ({
  id: 'p', managerId: 'm1', kind: 'law', status: 'pending', incident: 'An incident', payload: { text: 'A law' }, createdAt: '2026-10-13T10:00:00.000Z', ...patch,
});

const emptyView: ManagerGovernanceView = { resourceGrants: [], pending: [], denied: [], history: [], governanceEvictedDenials: 0 };

async function renderSection(view: Partial<ManagerGovernanceView>) {
  const events = { proposals: signal<GovernanceProposalView[]>([]) };
  const api = {
    getManagerGovernance: vi.fn().mockResolvedValue({ ...emptyView, ...view }),
    getNote: vi.fn().mockResolvedValue({ title: 'Q4 roadmap' }),
    getDataStore: vi.fn().mockResolvedValue({ displayName: 'Release table' }),
  };
  await render(ManagerGovernanceComponent, {
    bindings: [inputBinding('managerId', () => 'm1'), inputBinding('projectId', () => 'p1')],
    providers: [provideRouter([]), { provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: events }],
  });
  return { events, api };
}

describe('ManagerGovernanceComponent', () => {
  it('shows a denied proposal with its reason', async () => {
    await renderSection({ denied: [proposal({ id: 'd1', status: 'denied', denialReason: 'Too broad', payload: { text: 'Deploy any time' } })] });

    const denied = await screen.findByTestId('manager-governance-denied');
    expect(within(denied).getByText('Deploy any time')).toBeVisible();
    expect(within(denied).getByText(/Too broad/)).toBeVisible();
  });

  it('shows the pending proposals of the manager', async () => {
    await renderSection({ pending: [proposal({ id: 'p1', payload: { text: 'Pending law' } })] });

    expect(within(await screen.findByTestId('manager-governance-pending')).getByText('Pending law')).toBeVisible();
  });

  it('shows approved and withdrawn proposals in the history', async () => {
    await renderSection({
      history: [
        proposal({ id: 'h1', status: 'approved', payload: { text: 'Approved law' } }),
        proposal({ id: 'h2', status: 'withdrawn', payload: { text: 'Withdrawn law' } }),
      ],
    });

    const history = await screen.findByTestId('manager-governance-history');
    expect(within(history).getByText('Approved law')).toBeVisible();
    expect(within(history).getByText('Withdrawn law')).toBeVisible();
    expect(within(history).getByText('approved')).toBeVisible();
    expect(within(history).getByText('withdrawn')).toBeVisible();
  });

  it('labels the grants in force as informational, with the resolved resource name', async () => {
    await renderSection({ resourceGrants: [{ id: 'g1', resourceType: 'note', resourceId: 'n-1', role: 'reader', access: 'read', grantedAt: 't' }] });

    const grants = await screen.findByTestId('manager-governance-grants');
    expect(within(grants).getByText(/informational: not enforced yet/i)).toBeVisible();
    expect(await within(grants).findByText('Q4 roadmap')).toBeVisible();
  });

  it('tells how many older denials were evicted when there are some', async () => {
    await renderSection({ governanceEvictedDenials: 3 });

    expect(await screen.findByText('3 older denials evicted')).toBeVisible();
  });

  it('says nothing about evicted denials when none was evicted', async () => {
    await renderSection({ denied: [proposal({ id: 'd1', status: 'denied', denialReason: 'No' })] });
    await screen.findByTestId('manager-governance-denied');

    expect(screen.queryByText(/evicted/)).toBeNull();
  });

  it('reads the governance again when the pending proposals change', async () => {
    const { events, api } = await renderSection({});
    await waitFor(() => expect(api.getManagerGovernance).toHaveBeenCalledTimes(1));

    events.proposals.set([proposal({ id: 'new' })]);

    await waitFor(() => expect(api.getManagerGovernance).toHaveBeenCalledTimes(2));
  });

  it('renders hostile proposal text as inert plain text', async () => {
    const hostile = '<img src=x onerror="window.pwned=1"> **bold**';
    await renderSection({ denied: [proposal({ id: 'd1', status: 'denied', denialReason: hostile, payload: { text: hostile } })] });

    const denied = await screen.findByTestId('manager-governance-denied');
    expect(denied.querySelector('img, strong, script')).toBeNull();
    expect(within(denied).getAllByText(new RegExp('onerror')).length).toBeGreaterThan(0);
  });
});
