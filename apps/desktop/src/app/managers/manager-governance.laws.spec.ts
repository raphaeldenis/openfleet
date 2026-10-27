import { render, screen, waitFor, within } from '@testing-library/angular/zoneless';
import { inputBinding, signal } from '@angular/core';
import userEvent from '@testing-library/user-event';
import { provideRouter } from '@angular/router';
import type { LawView, ManagerGovernanceWithLawsView } from '@openfleet/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { connectToScriptedDaemon } from '../inbox/governance-events-harness';
import { ManagerGovernanceComponent } from './manager-governance.component';

const MANAGER_ID = 'm1';
const CONFLICT_COPY = 'This law changed since you opened it. Reload it.';

const law = (patch: Partial<LawView> = {}): LawView => ({
  id: 'law-1', managerId: MANAGER_ID, text: 'Never force-push', status: 'active', revision: 1,
  createdAt: '2026-10-13T10:00:00.000Z', updatedAt: '2026-10-13T10:00:00.000Z', approvedBy: 'admin', source: 'proposal', proposalId: 'prop-1', ...patch,
});

const viewWith = (laws: LawView[]): ManagerGovernanceWithLawsView => ({ laws, resourceGrants: [], pending: [], queued: [], denied: [], history: [], governanceEvictedDenials: 0 });

const lawConflict = () => new ApiError(409, 'PATCH → 409', 'law_revision_conflict', {
  error: 'law_revision_conflict', kind: 'conflict', retry: 'after_refresh', message: 'the law changed since it was read.', detail: { currentRev: 2 },
});

async function renderSection(laws: LawView[], apiPatch: Record<string, unknown> = {}) {
  const daemon = await connectToScriptedDaemon();
  const api = {
    getManagerGovernance: vi.fn().mockResolvedValue(viewWith(laws)),
    editLaw: vi.fn().mockResolvedValue({}),
    withdrawLaw: vi.fn().mockResolvedValue({}),
    getNote: vi.fn(),
    getDataStore: vi.fn(),
    ...apiPatch,
  };
  await render(ManagerGovernanceComponent, {
    bindings: [inputBinding('managerId', signal(MANAGER_ID)), inputBinding('projectId', () => 'p1')],
    providers: [provideRouter([]), { provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: daemon.events }],
  });
  return { ...daemon, api };
}

const lawsSection = () => screen.findByTestId('manager-governance-laws');
const editButton = (excerpt: string) => screen.getByRole('button', { name: `Edit law: ${excerpt}` });
const withdrawButton = (excerpt: string) => screen.getByRole('button', { name: `Withdraw law: ${excerpt}` });

afterEach(() => vi.unstubAllGlobals());

describe('the laws of a manager', () => {
  it('shows each active law with its text, revision and provenance', async () => {
    await renderSection([law(), law({ id: 'law-2', text: 'Close a session before a new branch', revision: 3, source: 'legacy' })]);

    const section = await lawsSection();
    expect(within(section).getByText('Never force-push')).toBeVisible();
    expect(within(section).getByText('Close a session before a new branch')).toBeVisible();
    expect(within(section).getByText(/Revision 3/)).toBeVisible();
    expect(within(section).getByText(/Approved proposal/)).toBeVisible();
  });

  it('lists a withdrawn law apart from the active ones, without an Edit or a Withdraw', async () => {
    await renderSection([law(), law({ id: 'law-2', text: 'Old rule', status: 'withdrawn', revision: 2, withdrawnAt: '2026-10-14T10:00:00.000Z', withdrawnBy: 'admin' })]);

    const withdrawn = await screen.findByTestId('manager-governance-withdrawn-laws');
    expect(within(withdrawn).getByText('Old rule')).toBeVisible();
    expect(within(withdrawn).queryByRole('button')).toBeNull();
    expect(within(await lawsSection()).queryByText('Old rule')).toBeNull();
  });

  describe('editing', () => {
    it('saves the new text with the revision that was read, then shows the new text', async () => {
      const { api } = await renderSection([law()]);
      await lawsSection();
      api.getManagerGovernance.mockResolvedValue(viewWith([law({ text: 'Never force-push to main', revision: 2 })]));

      await userEvent.click(editButton('Never force-push'));
      const field = screen.getByRole('textbox', { name: 'Law text' });
      expect(field).toHaveValue('Never force-push');
      await userEvent.clear(field);
      await userEvent.type(field, 'Never force-push to main');
      await userEvent.click(screen.getByRole('button', { name: 'Save law' }));

      expect(api.editLaw).toHaveBeenCalledWith({ lawId: 'law-1', text: 'Never force-push to main', expectedRevision: 1 });
      expect(await screen.findByText('Never force-push to main')).toBeVisible();
      expect(screen.queryByRole('textbox', { name: 'Law text' })).toBeNull();
    });

    it('refuses to save a blank text', async () => {
      const { api } = await renderSection([law()]);
      await lawsSection();

      await userEvent.click(editButton('Never force-push'));
      await userEvent.clear(screen.getByRole('textbox', { name: 'Law text' }));

      expect(screen.getByRole('button', { name: 'Save law' })).toBeDisabled();
      expect(api.editLaw).not.toHaveBeenCalled();
    });

    it('drops the edit and keeps the text when Cancel is pressed', async () => {
      const { api } = await renderSection([law()]);
      await lawsSection();
      await userEvent.click(editButton('Never force-push'));
      await userEvent.type(screen.getByRole('textbox', { name: 'Law text' }), ' anywhere');

      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('textbox', { name: 'Law text' })).toBeNull();
      expect(screen.getByText('Never force-push')).toBeVisible();
      expect(api.editLaw).not.toHaveBeenCalled();
    });

    it('tells that the law changed, reloads it and keeps the draft of the user when the revision is stale', async () => {
      const editLaw = vi.fn().mockRejectedValue(lawConflict());
      const { api } = await renderSection([law()], { editLaw });
      await lawsSection();
      api.getManagerGovernance.mockResolvedValue(viewWith([law({ text: 'Never force-push to main', revision: 2 })]));
      await userEvent.click(editButton('Never force-push'));
      const field = screen.getByRole('textbox', { name: 'Law text' });
      await userEvent.clear(field);
      await userEvent.type(field, 'My own wording');

      await userEvent.click(screen.getByRole('button', { name: 'Save law' }));

      expect(await screen.findByText(CONFLICT_COPY)).toBeVisible();
      await waitFor(() => expect(api.getManagerGovernance).toHaveBeenCalledTimes(2));
      expect(screen.getByRole('textbox', { name: 'Law text' })).toHaveValue('My own wording');
      expect(await screen.findByText('Never force-push to main')).toBeVisible();
    });

    it('saves the kept draft against the reloaded revision', async () => {
      const editLaw = vi.fn().mockRejectedValueOnce(lawConflict()).mockResolvedValue({});
      const { api } = await renderSection([law()], { editLaw });
      await lawsSection();
      api.getManagerGovernance.mockResolvedValue(viewWith([law({ text: 'Never force-push to main', revision: 2 })]));
      await userEvent.click(editButton('Never force-push'));
      const field = screen.getByRole('textbox', { name: 'Law text' });
      await userEvent.clear(field);
      await userEvent.type(field, 'My own wording');
      await userEvent.click(screen.getByRole('button', { name: 'Save law' }));
      await screen.findByText('Never force-push to main');

      await userEvent.click(screen.getByRole('button', { name: 'Save law' }));

      expect(editLaw).toHaveBeenLastCalledWith({ lawId: 'law-1', text: 'My own wording', expectedRevision: 2 });
    });

    it('says the daemon cannot be reached after a network failure and keeps the draft', async () => {
      const editLaw = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      await renderSection([law()], { editLaw });
      await lawsSection();
      await userEvent.click(editButton('Never force-push'));
      await userEvent.type(screen.getByRole('textbox', { name: 'Law text' }), '!');

      await userEvent.click(screen.getByRole('button', { name: 'Save law' }));

      expect(await screen.findByText(/Can’t reach the OpenFleet daemon/)).toBeVisible();
      expect(screen.getByRole('textbox', { name: 'Law text' })).toHaveValue('Never force-push!');
    });
  });

  describe('withdrawing', () => {
    it('asks for a confirmation before anything is sent', async () => {
      const { api } = await renderSection([law()]);
      await lawsSection();

      await userEvent.click(withdrawButton('Never force-push'));

      expect(screen.getByRole('button', { name: 'Confirm withdrawal' })).toBeVisible();
      expect(api.withdrawLaw).not.toHaveBeenCalled();
    });

    it('sends nothing when the confirmation is cancelled', async () => {
      const { api } = await renderSection([law()]);
      await lawsSection();
      await userEvent.click(withdrawButton('Never force-push'));

      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('button', { name: 'Confirm withdrawal' })).toBeNull();
      expect(api.withdrawLaw).not.toHaveBeenCalled();
    });

    it('withdraws the law at the revision that was read and moves it to the withdrawn laws', async () => {
      const { api } = await renderSection([law({ revision: 4 })]);
      await lawsSection();
      api.getManagerGovernance.mockResolvedValue(viewWith([law({ revision: 5, status: 'withdrawn', withdrawnAt: '2026-10-14T10:00:00.000Z', withdrawnBy: 'admin' })]));
      await userEvent.click(withdrawButton('Never force-push'));

      await userEvent.click(screen.getByRole('button', { name: 'Confirm withdrawal' }));

      expect(api.withdrawLaw).toHaveBeenCalledWith({ lawId: 'law-1', expectedRevision: 4 });
      const withdrawn = await screen.findByTestId('manager-governance-withdrawn-laws');
      expect(within(withdrawn).getByText('Never force-push')).toBeVisible();
    });

    it('tells that the law changed and reloads it when the revision is stale', async () => {
      const withdrawLaw = vi.fn().mockRejectedValue(lawConflict());
      const { api } = await renderSection([law()], { withdrawLaw });
      await lawsSection();
      api.getManagerGovernance.mockResolvedValue(viewWith([law({ text: 'Never force-push to main', revision: 2 })]));
      await userEvent.click(withdrawButton('Never force-push'));

      await userEvent.click(screen.getByRole('button', { name: 'Confirm withdrawal' }));

      expect(await screen.findByText(CONFLICT_COPY)).toBeVisible();
      expect(await screen.findByText('Never force-push to main')).toBeVisible();
    });
  });

  it('reloads the laws when the daemon announces a change of one of this manager’s laws', async () => {
    const { api, lawEventOnDaemon } = await renderSection([law()]);
    await lawsSection();
    api.getManagerGovernance.mockResolvedValue(viewWith([law({ text: 'Reworded elsewhere', revision: 2 })]));

    lawEventOnDaemon('law.updated', law({ text: 'Reworded elsewhere', revision: 2 }));

    expect(await screen.findByText('Reworded elsewhere')).toBeVisible();
  });

  it('does not reload for the law of another manager', async () => {
    const { api, lawEventOnDaemon } = await renderSection([law()]);
    await lawsSection();

    lawEventOnDaemon('law.updated', law({ managerId: 'someone-else' }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(api.getManagerGovernance).toHaveBeenCalledTimes(1);
  });
});
