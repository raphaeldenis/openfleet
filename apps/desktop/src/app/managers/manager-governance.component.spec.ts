import { render, screen, waitFor, within } from '@testing-library/angular/zoneless';
import { inputBinding, signal } from '@angular/core';
import userEvent from '@testing-library/user-event';
import { provideRouter } from '@angular/router';
import type { GovernanceProposalView, ManagerGovernanceWithLawsView, ResourceGrantView } from '@openfleet/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { connectToScriptedDaemon } from '../inbox/governance-events-harness';
import { ManagerGovernanceComponent } from './manager-governance.component';

const ASYNC_SETTLE_MS = 50;
const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e);
const HOSTILE_MARKUP = '<img src=x onerror="window.pwned=1"> **bold**';

const proposal = (patch: Partial<GovernanceProposalView>): GovernanceProposalView => ({
  id: 'p', managerId: 'm1', kind: 'law', status: 'pending', incident: 'An incident', payload: { text: 'A law' }, createdAt: '2026-10-13T10:00:00.000Z', ...patch,
});

const emptyView: ManagerGovernanceWithLawsView = { laws: [], resourceGrants: [], pending: [], denied: [], history: [], governanceEvictedDenials: 0 };
const grant = (patch: Partial<ResourceGrantView> = {}): ResourceGrantView => ({ id: 'g1', resourceType: 'note', resourceId: 'n-1', role: 'reader', access: 'read', grantedAt: 't', ...patch });

async function renderSection(view: Partial<ManagerGovernanceWithLawsView>, apiPatch: Record<string, unknown> = {}) {
  const getManagerGovernance = vi.fn().mockResolvedValue({ ...emptyView, ...view });
  return renderSectionWith({ getManagerGovernance, ...apiPatch });
}

async function renderSectionWith(apiPatch: Record<string, unknown>) {
  const daemon = await connectToScriptedDaemon();
  const managerId = signal('m1');
  const api = {
    getManagerGovernance: vi.fn().mockResolvedValue(emptyView),
    getNote: vi.fn().mockResolvedValue({ title: 'Q4 roadmap' }),
    getDataStore: vi.fn().mockResolvedValue({ displayName: 'Release table' }),
    ...apiPatch,
  };
  await render(ManagerGovernanceComponent, {
    bindings: [inputBinding('managerId', managerId), inputBinding('projectId', () => 'p1')],
    providers: [provideRouter([]), { provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: daemon.events }],
  });
  return { ...daemon, api, managerId };
}

afterEach(() => vi.unstubAllGlobals());

describe('ManagerGovernanceComponent', () => {
  it('shows a denied proposal with its reason', async () => {
    await renderSection({ denied: [proposal({ id: 'd1', status: 'denied', denialReason: 'Too broad', payload: { text: 'Deploy any time' } })] });

    const denied = await screen.findByTestId('manager-governance-denied');
    expect(within(denied).getByText('Deploy any time')).toBeVisible();
    expect(within(denied).getByText(/Too broad/)).toBeVisible();
  });

  it('shows the pending proposals of the manager, with the link to decide in the Inbox outside the heading', async () => {
    await renderSection({ pending: [proposal({ id: 'p1', payload: { text: 'Pending law' } })] });

    const pending = await screen.findByTestId('manager-governance-pending');
    expect(within(pending).getByText('Pending law')).toBeVisible();
    expect(within(pending).getByRole('heading', { name: 'Pending' })).toBeVisible();
    expect(within(pending).getByRole('link', { name: 'Decide in the Inbox' })).toBeVisible();
  });

  it('shows approved and withdrawn proposals in the history with readable statuses', async () => {
    await renderSection({
      history: [
        proposal({ id: 'h1', status: 'approved', payload: { text: 'Approved law' } }),
        proposal({ id: 'h2', status: 'withdrawn', payload: { text: 'Withdrawn law' } }),
      ],
    });

    const history = await screen.findByTestId('manager-governance-history');
    expect(within(history).getByText('Approved law')).toBeVisible();
    expect(within(history).getByText('Withdrawn law')).toBeVisible();
    expect(within(history).getByText('Approved')).toBeVisible();
    expect(within(history).getByText('Withdrawn')).toBeVisible();
    expect(within(history).queryByText('approved')).toBeNull();
  });

  it('shows how long ago each proposal of the history was decided', async () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    await renderSection({ history: [proposal({ id: 'h1', status: 'approved', decidedAt: fiveMinutesAgo })] });

    const history = await screen.findByTestId('manager-governance-history');

    expect(within(history).getByText('5 min ago')).toBeVisible();
  });

  describe('long lists', () => {
    const deniedProposals = (count: number) =>
      Array.from({ length: count }, (_, index) => proposal({ id: `d${index}`, status: 'denied', denialReason: 'No', payload: { text: `Denied law ${index}` } }));
    const historyProposals = (count: number) =>
      Array.from({ length: count }, (_, index) => proposal({ id: `h${index}`, status: 'approved', payload: { text: `Approved law ${index}` } }));

    it('shows the 5 first denials and offers to show all 20 of 21 refusals once one is evicted', async () => {
      await renderSection({ denied: deniedProposals(20), governanceEvictedDenials: 1 });

      const denied = await screen.findByTestId('manager-governance-denied');

      expect(within(denied).getAllByRole('listitem')).toHaveLength(5);
      expect(within(denied).getByRole('button', { name: 'Show all 20' })).toHaveAttribute('aria-expanded', 'false');
    });

    it('shows every denial, then folds them back, with the button', async () => {
      await renderSection({ denied: deniedProposals(20) });
      const denied = await screen.findByTestId('manager-governance-denied');

      await userEvent.click(within(denied).getByRole('button', { name: 'Show all 20' }));

      expect(within(denied).getAllByRole('listitem')).toHaveLength(20);
      expect(within(denied).getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');

      await userEvent.click(within(denied).getByRole('button', { name: 'Show fewer' }));

      expect(within(denied).getAllByRole('listitem')).toHaveLength(5);
    });

    it('folds the history after 5 entries, apart from the denials', async () => {
      await renderSection({ denied: deniedProposals(3), history: historyProposals(8) });
      const history = await screen.findByTestId('manager-governance-history');

      expect(within(history).getAllByRole('listitem')).toHaveLength(5);
      expect(within(history).getByRole('button', { name: 'Show all 8' })).toBeVisible();
      expect(within(screen.getByTestId('manager-governance-denied')).queryByRole('button')).toBeNull();
    });

    it('offers no button for exactly 5 entries', async () => {
      await renderSection({ history: historyProposals(5) });
      const history = await screen.findByTestId('manager-governance-history');

      expect(within(history).getAllByRole('listitem')).toHaveLength(5);
      expect(within(history).queryByRole('button')).toBeNull();
    });
  });

  it('labels the grants in force as informational, with the resolved resource name and a readable access', async () => {
    await renderSection({ resourceGrants: [grant({ access: 'readWrite' })] });

    const grants = await screen.findByTestId('manager-governance-grants');
    expect(within(grants).getByText(/informational: not enforced yet/i)).toBeVisible();
    expect(await within(grants).findByText('Q4 roadmap')).toBeVisible();
    expect(within(grants).getByText('Read and write as reader')).toBeVisible();
  });

  it('tells how many older denials were evicted when there are some', async () => {
    await renderSection({ governanceEvictedDenials: 3 });

    expect(await screen.findByText('3 older denials evicted')).toBeVisible();
  });

  it('says "1 older denial evicted" in the singular for one', async () => {
    await renderSection({ governanceEvictedDenials: 1 });

    expect(await screen.findByText('1 older denial evicted')).toBeVisible();
  });

  it('says nothing about evicted denials when none was evicted', async () => {
    await renderSection({ denied: [proposal({ id: 'd1', status: 'denied', denialReason: 'No' })] });
    await screen.findByTestId('manager-governance-denied');

    expect(screen.queryByText(/evicted/)).toBeNull();
  });

  describe('reading again', () => {
    it('reads the governance again when a pending proposal of this manager is announced', async () => {
      const { proposeOnDaemon, api } = await renderSection({});
      await waitFor(() => expect(api.getManagerGovernance).toHaveBeenCalledTimes(1));

      proposeOnDaemon(proposal({ id: 'new' }));

      await waitFor(() => expect(api.getManagerGovernance).toHaveBeenCalledTimes(2));
    });

    it('does not read again for a proposal of another manager', async () => {
      const { proposeOnDaemon, api } = await renderSection({});
      await waitFor(() => expect(api.getManagerGovernance).toHaveBeenCalledTimes(1));

      proposeOnDaemon(proposal({ id: 'other', managerId: 'm2' }));
      await new Promise((resolve) => setTimeout(resolve, ASYNC_SETTLE_MS));
      expect(api.getManagerGovernance).toHaveBeenCalledTimes(1);

      proposeOnDaemon(proposal({ id: 'mine' }));

      await waitFor(() => expect(api.getManagerGovernance).toHaveBeenCalledTimes(2));
    });

    it('reads again when a snapshot replaces the pending proposals of this manager', async () => {
      const { sendSnapshot, api } = await renderSection({});
      await waitFor(() => expect(api.getManagerGovernance).toHaveBeenCalledTimes(1));

      sendSnapshot({ proposals: [proposal({ id: 'after-reconnect' })] });

      await waitFor(() => expect(api.getManagerGovernance).toHaveBeenCalledTimes(2));
    });
  });

  describe('when the manager shown changes', () => {
    const viewOfA: ManagerGovernanceWithLawsView = { ...emptyView, pending: [proposal({ id: 'pa', managerId: 'a', payload: { text: 'Law of A' } })] };

    it('never shows the governance of the previous manager while the next one loads', async () => {
      const loadOfB = new Promise<ManagerGovernanceWithLawsView>(() => undefined);
      const getManagerGovernance = vi.fn((id: string) => (id === 'a' ? Promise.resolve(viewOfA) : loadOfB));
      const { managerId } = await renderSectionWith({ getManagerGovernance });
      managerId.set('a');
      expect(await screen.findByText('Law of A')).toBeVisible();

      managerId.set('b');

      await waitFor(() => expect(screen.queryByText('Law of A')).toBeNull());
      expect(screen.getByText('Loading…')).toBeVisible();
    });

    it('shows a readable error, and never the governance of the previous manager, when the next one fails to load', async () => {
      const getManagerGovernance = vi.fn((id: string) => (id === 'a' ? Promise.resolve(viewOfA) : Promise.reject(new ApiError(404, 'GET → 404', 'manager_not_found'))));
      const { managerId } = await renderSectionWith({ getManagerGovernance });
      managerId.set('a');
      expect(await screen.findByText('Law of A')).toBeVisible();

      managerId.set('b');

      expect(await screen.findByRole('alert')).toHaveTextContent(/./);
      expect(screen.queryByText('Law of A')).toBeNull();
      expect(screen.queryByText(/manager_not_found/)).toBeNull();
      expect(screen.queryByText('No proposal yet.')).toBeNull();
    });

    it('says the daemon cannot be reached when the first load fails on the network', async () => {
      await renderSectionWith({ getManagerGovernance: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) });

      expect(await screen.findByText(/Can’t reach the OpenFleet daemon/)).toBeVisible();
      expect(screen.queryByText(/Failed to fetch/)).toBeNull();
    });
  });

  describe('hostile text', () => {
    it('renders hostile proposal text as inert plain text', async () => {
      await renderSection({ denied: [proposal({ id: 'd1', status: 'denied', denialReason: HOSTILE_MARKUP, payload: { text: HOSTILE_MARKUP }, incident: HOSTILE_MARKUP })] });

      const denied = await screen.findByTestId('manager-governance-denied');
      expect(denied.querySelector('img, strong, script')).toBeNull();
      expect(within(denied).getAllByText(new RegExp('onerror')).length).toBeGreaterThan(0);
    });

    it.each(['action', 'scope', 'condition', 'exclusions'])('renders a hostile %s of a permission as inert plain text with its bidirectional control escaped', async (field) => {
      const payload = { action: 'a', scope: 's', condition: 'c', exclusions: 'e', [field]: `${HOSTILE_MARKUP}${RIGHT_TO_LEFT_OVERRIDE}` };
      await renderSection({ pending: [proposal({ id: 'pp', kind: 'permission', payload, incident: `${HOSTILE_MARKUP}${RIGHT_TO_LEFT_OVERRIDE}` })] });

      const pending = await screen.findByTestId('manager-governance-pending');
      expect(pending).toHaveTextContent('<U+202E>');
      expect(pending.querySelector('img, strong, script')).toBeNull();
    });

    it('renders a hostile resource name and a hostile role of a grant as inert plain text', async () => {
      const getNote = vi.fn().mockResolvedValue({ title: `${HOSTILE_MARKUP}${RIGHT_TO_LEFT_OVERRIDE}` });
      await renderSection({ resourceGrants: [grant({ role: HOSTILE_MARKUP })] }, { getNote });

      const grants = await screen.findByTestId('manager-governance-grants');
      await waitFor(() => expect(grants).toHaveTextContent('<U+202E>'));
      expect(grants.querySelector('img, strong, script')).toBeNull();
    });
  });
});
