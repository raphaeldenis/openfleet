import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import type { GovernanceProposalView } from '@openfleet/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { sessionOf } from '../working-state/working-state-fixtures';
import { connectToScriptedDaemon } from './governance-events-harness';
import { InboxComponent } from './inbox.component';

const proposal = (id: string, patch: Partial<GovernanceProposalView> = {}): GovernanceProposalView => ({
  id, managerId: 'm1', kind: 'law', status: 'pending', incident: `Incident of ${id}`, payload: { text: `Law ${id}` }, createdAt: new Date().toISOString(), ...patch,
});

const approvalGate = { id: 'a1', sessionId: 'm1', toolName: 'Bash', toolInput: {}, status: 'pending', createdAt: 't' };
const manager = sessionOf({ id: 'm1', name: 'Lloyd', role: 'manager', projectId: 'p1' });
const COPY_INSTRUCTION = 'Copy this into the Laws section of the mission note.';

@Component({ selector: 'stub-elsewhere', template: '<span data-testid="stub-elsewhere">elsewhere</span>' })
class StubElsewhereComponent {}

async function connect(proposals: GovernanceProposalView[]) {
  const daemon = await connectToScriptedDaemon({ sessions: [manager], proposals });
  const api = { decide: vi.fn(), decideProposal: vi.fn().mockResolvedValue({}) };
  return { ...daemon, api, providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: daemon.events }] };
}

async function renderInbox(proposals: GovernanceProposalView[]) {
  const connected = await connect(proposals);
  await render(InboxComponent, { providers: [provideRouter([]), ...connected.providers] });
  return connected;
}

const approveLaw = async (id: string) => userEvent.click(screen.getByRole('button', { name: `Approve law proposal from Lloyd: Law ${id}` }));

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('InboxComponent governance proposals', () => {
  it('user sees a pending proposal with its incident, and the Inbox count rises by one', async () => {
    await renderInbox([proposal('p1')]);

    expect(screen.getByText('Incident of p1')).toBeVisible();
    expect(screen.getByTestId('inbox-count')).toHaveTextContent('1');
  });

  it('user sees pending proposals add up with the approvals in the Inbox count', async () => {
    const { events } = await renderInbox([proposal('p1'), proposal('p2')]);

    events.approvals.set([approvalGate] as never);

    await waitFor(() => expect(screen.getByTestId('inbox-count')).toHaveTextContent('3'));
    expect(screen.getByTestId('inbox-count')).toHaveAccessibleName('3 items need you');
  });

  it('user sees the Governance filter hold only the proposals', async () => {
    const { events } = await renderInbox([proposal('p1')]);
    events.approvals.set([approvalGate] as never);

    await userEvent.click(screen.getByTestId('inbox-filter-governance'));

    expect(screen.getByTestId('inbox-filter-governance')).toHaveTextContent('1');
    expect(screen.getByText('Incident of p1')).toBeVisible();
    expect(screen.queryByTestId('inbox-gate-card')).toBeNull();
  });

  it('user sees the count fall and the card leave once the daemon announces the approval', async () => {
    const lawOne = proposal('p1');
    const { resolveOnDaemon } = await renderInbox([lawOne, proposal('p2')]);

    await approveLaw('p1');
    resolveOnDaemon(lawOne);

    await waitFor(() => expect(screen.getByTestId('inbox-count')).toHaveTextContent('1'));
    expect(screen.queryByText('Incident of p1')).toBeNull();
  });

  it('user sees the empty state when nothing is pending', async () => {
    await renderInbox([]);

    expect(screen.getByTestId('inbox-empty')).toBeVisible();
    expect(screen.queryByTestId('inbox-count')).toBeNull();
  });

  describe('after the last pending law is approved', () => {
    async function approveTheOnlyLaw() {
      const onlyLaw = proposal('p1');
      const connected = await renderInbox([onlyLaw]);
      await approveLaw('p1');
      connected.resolveOnDaemon(onlyLaw);
      await screen.findByText(COPY_INSTRUCTION);
      return connected;
    }

    it('user is not told that nothing needs them while the text to copy is still there', async () => {
      await approveTheOnlyLaw();

      expect(screen.queryByTestId('inbox-empty')).toBeNull();
      expect(screen.queryByText('Nothing needs you')).toBeNull();
    });

    it('user sees the empty state once the approved text is dismissed', async () => {
      await approveTheOnlyLaw();

      await userEvent.click(screen.getByRole('button', { name: 'Dismiss law proposal from Lloyd: Law p1' }));

      expect(screen.getByTestId('inbox-empty')).toBeVisible();
      expect(screen.queryByText(COPY_INSTRUCTION)).toBeNull();
    });

    it('user finds the text to copy again after switching to Questions and back to Governance', async () => {
      await approveTheOnlyLaw();

      await userEvent.click(screen.getByTestId('inbox-filter-questions'));
      expect(screen.queryByText(COPY_INSTRUCTION)).toBeNull();
      await userEvent.click(screen.getByTestId('inbox-filter-governance'));

      expect(await screen.findByText(COPY_INSTRUCTION)).toBeVisible();
      expect(screen.getByText('Law p1')).toBeVisible();
    });

    it('user finds the text to copy again after leaving the Inbox and coming back', async () => {
      const onlyLaw = proposal('p1');
      const connected = await connect([onlyLaw]);
      TestBed.configureTestingModule({
        providers: [provideRouter([{ path: 'inbox', component: InboxComponent }, { path: 'elsewhere', component: StubElsewhereComponent }]), ...connected.providers],
      });
      const harness = await RouterTestingHarness.create('/inbox');
      await approveLaw('p1');
      connected.resolveOnDaemon(onlyLaw);
      await screen.findByText(COPY_INSTRUCTION);

      await harness.navigateByUrl('/elsewhere');
      expect(screen.queryByText(COPY_INSTRUCTION)).toBeNull();
      await harness.navigateByUrl('/inbox');

      expect(await screen.findByText(COPY_INSTRUCTION)).toBeVisible();
      expect(TestBed.inject(Router).url).toBe('/inbox');
    });
  });

  describe('focus', () => {
    it('moves the focus to the Governance filter when the last card leaves', async () => {
      const onlyLaw = proposal('p1');
      const { resolveOnDaemon } = await renderInbox([onlyLaw]);
      await userEvent.click(screen.getByTestId('inbox-filter-governance'));

      await approveLaw('p1');
      resolveOnDaemon(onlyLaw);

      await waitFor(() => expect(screen.getByTestId('inbox-filter-governance')).toHaveFocus());
    });

    it('gives the focus back to the Deny button of the only card when its denial is cancelled', async () => {
      await renderInbox([proposal('p1')]);
      await userEvent.click(screen.getByTestId('inbox-filter-governance'));
      await userEvent.click(screen.getByRole('button', { name: 'Deny law proposal from Lloyd: Law p1' }));

      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(screen.getByRole('button', { name: 'Deny law proposal from Lloyd: Law p1' })).toHaveFocus());
    });
  });
});
