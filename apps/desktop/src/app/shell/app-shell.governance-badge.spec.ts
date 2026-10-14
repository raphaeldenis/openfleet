import { TestBed } from '@angular/core/testing';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideRouter } from '@angular/router';
import { screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import type { GovernanceProposalView } from '@openfleet/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { connectToScriptedDaemon } from '../inbox/governance-events-harness';
import { InboxComponent } from '../inbox/inbox.component';
import { sessionOf } from '../working-state/working-state-fixtures';
import { AppShellComponent } from './app-shell.component';
import { InMemorySessionTodosSource, SESSION_TODOS_SOURCE } from './todos/session-todos-source';

const proposal = (id: string): GovernanceProposalView => ({
  id, managerId: 'm1', kind: 'law', status: 'pending', incident: `Incident of ${id}`, payload: { text: `Law ${id}` }, createdAt: new Date().toISOString(),
});

const manager = sessionOf({ id: 'm1', name: 'Lloyd', role: 'manager', projectId: 'p1' });

async function openShellOnInbox(proposals: GovernanceProposalView[]) {
  const daemon = await connectToScriptedDaemon({ sessions: [manager], proposals });
  const api = { decide: vi.fn(), decideProposal: vi.fn().mockResolvedValue({}) };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '', component: AppShellComponent, children: [{ path: 'inbox', component: InboxComponent }] }]),
      { provide: FleetEventsService, useValue: daemon.events },
      { provide: FleetApiService, useValue: api },
      { provide: SESSION_TODOS_SOURCE, useValue: new InMemorySessionTodosSource() },
    ],
  });
  const harness = await RouterTestingHarness.create('/inbox');
  const sidebarBadge = () => (harness.routeNativeElement as HTMLElement).querySelector('[data-testid="nav-inbox-badge"]');
  return { ...daemon, sidebarBadge };
}

afterEach(() => vi.unstubAllGlobals());

describe('the sidebar Inbox badge with governance proposals', () => {
  it('counts each pending proposal', async () => {
    const { sidebarBadge } = await openShellOnInbox([proposal('p1'), proposal('p2')]);

    expect(sidebarBadge()).toHaveTextContent('2');
  });

  it('rises by one when the daemon announces a proposal', async () => {
    const { sidebarBadge, proposeOnDaemon } = await openShellOnInbox([]);
    expect(sidebarBadge()).toBeNull();

    proposeOnDaemon(proposal('p1'));

    await waitFor(() => expect(sidebarBadge()).toHaveTextContent('1'));
  });

  it('falls by one once the daemon announces the decision', async () => {
    const lawOne = proposal('p1');
    const { sidebarBadge, resolveOnDaemon } = await openShellOnInbox([lawOne, proposal('p2')]);

    await userEvent.click(screen.getByRole('button', { name: 'Approve law proposal from Lloyd: Law p1' }));
    resolveOnDaemon(lawOne);

    await waitFor(() => expect(sidebarBadge()).toHaveTextContent('1'));
  });

  it('shows the same count as the Inbox title', async () => {
    const { sidebarBadge } = await openShellOnInbox([proposal('p1'), proposal('p2'), proposal('p3')]);

    expect(sidebarBadge()?.textContent?.trim()).toBe(screen.getByTestId('inbox-count').textContent?.trim());
  });
});
