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
const COPY_INSTRUCTION = 'Copy this into the mission note, where your standing permissions are written.';

@Component({ selector: 'stub-elsewhere', template: '<span data-testid="stub-elsewhere">elsewhere</span>' })
class StubElsewhereComponent {}

async function connect(proposals: GovernanceProposalView[], queuedCounts?: Record<string, number>) {
  const daemon = await connectToScriptedDaemon({ sessions: [manager], proposals, queuedCounts });
  const api = { decide: vi.fn(), decideProposal: vi.fn().mockResolvedValue({}) };
  return { ...daemon, api, providers: [{ provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: daemon.events }] };
}

async function renderInbox(proposals: GovernanceProposalView[], queuedCounts?: Record<string, number>) {
  const connected = await connect(proposals, queuedCounts);
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

  describe('the waiting list', () => {
    const governanceChip = () => screen.getByTestId('inbox-filter-governance');

    it('user sees how many proposals wait on the Governance chip while its to-decide count stays the same', async () => {
      await renderInbox([proposal('p1'), proposal('p2')], { m1: 2, m2: 1 });

      expect(governanceChip()).toHaveTextContent('Governance 2 · 3 waiting');
      expect(screen.getByTestId('inbox-count')).toHaveTextContent('2');
      expect(screen.getByTestId('inbox-filter-all')).toHaveTextContent('All 2');
    });

    it('user sees no waiting suffix when nothing waits', async () => {
      await renderInbox([proposal('p1')]);

      expect(governanceChip()).toHaveTextContent(/^Governance 1$/);
    });

    it('user sees the waiting suffix follow the daemon as proposals are parked and released', async () => {
      const { queueChangedOnDaemon, proposeOnDaemon } = await renderInbox([proposal('p1')], { m1: 1 });
      expect(governanceChip()).toHaveTextContent('Governance 1 · 1 waiting');

      queueChangedOnDaemon('m1', 4);
      await waitFor(() => expect(governanceChip()).toHaveTextContent('Governance 1 · 4 waiting'));

      proposeOnDaemon(proposal('released'));
      queueChangedOnDaemon('m1', 3);
      await waitFor(() => expect(governanceChip()).toHaveTextContent('Governance 2 · 3 waiting'));

      queueChangedOnDaemon('m1', 0);
      await waitFor(() => expect(governanceChip()).toHaveTextContent(/^Governance 2$/));
    });

    it('user sees the waiting proposals announced with the proposals to decide', async () => {
      await renderInbox([proposal('p1')], { m1: 3 });

      expect(screen.getByRole('status', { name: 'Governance queue' })).toHaveTextContent('1 governance proposal needs you, 3 waiting');
    });

    it('user still sees an empty Inbox with no count when proposals only wait', async () => {
      await renderInbox([], { m1: 2 });

      expect(governanceChip()).toHaveTextContent('Governance 0 · 2 waiting');
      expect(screen.queryByTestId('inbox-count')).toBeNull();
      expect(screen.getByTestId('inbox-empty')).toBeVisible();
    });
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

  it('user is told that nothing needs them as soon as the last pending law is approved: there is no text to copy', async () => {
    const onlyLaw = proposal('p1');
    const { resolveOnDaemon } = await renderInbox([onlyLaw]);

    await approveLaw('p1');
    resolveOnDaemon(onlyLaw);

    expect(await screen.findByTestId('inbox-empty')).toBeVisible();
    expect(screen.queryByText(/Copy this into/)).toBeNull();
  });

  describe('after the last pending permission is approved', () => {
    const permission = proposal('p1', { kind: 'permission', payload: { action: 'git tag', scope: 'release branches', condition: 'CI is green', exclusions: 'hotfix branches' } });

    async function approveTheOnlyPermission() {
      const connected = await renderInbox([permission]);
      await userEvent.click(screen.getByRole('button', { name: 'Approve permission proposal from Lloyd: git tag' }));
      connected.resolveOnDaemon(permission);
      await screen.findByText(COPY_INSTRUCTION);
      return connected;
    }

    it('user is not told that nothing needs them while the text to copy is still there', async () => {
      await approveTheOnlyPermission();

      expect(screen.queryByTestId('inbox-empty')).toBeNull();
      expect(screen.queryByText('Nothing needs you')).toBeNull();
    });

    it('user sees the empty state once the approved text is dismissed', async () => {
      await approveTheOnlyPermission();

      await userEvent.click(screen.getByRole('button', { name: 'Dismiss permission proposal from Lloyd: git tag' }));

      expect(screen.getByTestId('inbox-empty')).toBeVisible();
      expect(screen.queryByText(COPY_INSTRUCTION)).toBeNull();
    });

    it('user finds the text to copy again after switching to Questions and back to Governance', async () => {
      await approveTheOnlyPermission();

      await userEvent.click(screen.getByTestId('inbox-filter-questions'));
      expect(screen.queryByText(COPY_INSTRUCTION)).toBeNull();
      await userEvent.click(screen.getByTestId('inbox-filter-governance'));

      expect(await screen.findByText(COPY_INSTRUCTION)).toBeVisible();
      expect(screen.getByText(/git tag/)).toBeVisible();
    });

    it('user finds the text to copy again after leaving the Inbox and coming back', async () => {
      const onlyLaw = permission;
      const connected = await connect([onlyLaw]);
      TestBed.configureTestingModule({
        providers: [provideRouter([{ path: 'inbox', component: InboxComponent }, { path: 'elsewhere', component: StubElsewhereComponent }]), ...connected.providers],
      });
      const harness = await RouterTestingHarness.create('/inbox');
      await userEvent.click(screen.getByRole('button', { name: 'Approve permission proposal from Lloyd: git tag' }));
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
