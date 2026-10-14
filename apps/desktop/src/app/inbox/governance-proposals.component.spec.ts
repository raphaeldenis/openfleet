import { render, screen, waitFor, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import type { GovernanceProposalView, ManagerView, Session } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { GovernanceProposalsComponent } from './governance-proposals.component';

const MANAGER_ID = 'm1';
const PROJECT_ID = 'p1';
const MINUTE_MS = 60_000;

const lawProposal = (patch: Partial<GovernanceProposalView> = {}): GovernanceProposalView => ({
  id: 'prop-law', managerId: MANAGER_ID, kind: 'law', status: 'pending', incident: 'Deploy broke twice',
  payload: { text: 'Never deploy on Friday' }, createdAt: new Date(Date.now() - 5 * MINUTE_MS).toISOString(), ...patch,
});

const permissionProposal = (): GovernanceProposalView => ({
  id: 'prop-perm', managerId: MANAGER_ID, kind: 'permission', status: 'pending', incident: 'Needs to tag releases',
  payload: { action: 'git tag', scope: 'release branches', condition: 'CI is green', exclusions: 'hotfix branches' }, createdAt: new Date().toISOString(),
});

const accessProposal = (resourceType: 'note' | 'dataStore' = 'note'): GovernanceProposalView => ({
  id: 'prop-access', managerId: MANAGER_ID, kind: 'resourceAccess', status: 'pending', incident: 'Reads the roadmap',
  payload: { resourceType, resourceId: 'res-uuid-1', access: 'read', role: 'reader' }, createdAt: new Date().toISOString(),
});

const managerSession = { id: MANAGER_ID, name: 'Lloyd', emoji: '🧭', state: 'idle', role: 'manager', projectId: PROJECT_ID } as Session;
const managerView = { sessionId: MANAGER_ID, missionNoteId: 'mission-1' } as ManagerView;

async function setup(proposals: GovernanceProposalView[], apiPatch: Record<string, unknown> = {}) {
  const events = { sessions: signal([managerSession]), managers: signal([managerView]), proposals: signal(proposals) };
  const api = {
    decideProposal: vi.fn().mockResolvedValue({}),
    getNote: vi.fn().mockResolvedValue({ id: 'res-uuid-1', title: 'Q4 roadmap' }),
    getDataStore: vi.fn().mockResolvedValue({ id: 'res-uuid-1', displayName: 'Release table' }),
    ...apiPatch,
  };
  await render(GovernanceProposalsComponent, { providers: [provideRouter([]), { provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: events }] });
  return { events, api };
}

describe('GovernanceProposalsComponent', () => {
  it('shows a pending law with its manager, type, text, incident and age', async () => {
    await setup([lawProposal()]);

    const card = screen.getByTestId('governance-card');
    expect(within(card).getByText('Lloyd')).toBeVisible();
    expect(within(card).getByText('LAW')).toBeVisible();
    expect(within(card).getByText('Never deploy on Friday')).toBeVisible();
    expect(within(card).getByText(/Deploy broke twice/)).toBeVisible();
    expect(within(card).getByTestId('governance-age')).toHaveTextContent('5 min');
  });

  it('shows the four fields of a permission', async () => {
    await setup([permissionProposal()]);

    const card = screen.getByTestId('governance-card');
    ['git tag', 'release branches', 'CI is green', 'hotfix branches'].forEach((value) => expect(within(card).getByText(value)).toBeVisible());
    ['Action', 'Scope', 'Condition', 'Exclusions'].forEach((label) => expect(within(card).getByText(label)).toBeVisible());
  });

  it('shows the title of the note an access request names, with its access and role, not its id', async () => {
    await setup([accessProposal('note')]);

    expect(await screen.findByText('Q4 roadmap')).toBeVisible();
    expect(screen.queryByText('res-uuid-1')).toBeNull();
    expect(screen.getByText('read')).toBeVisible();
    expect(screen.getByText('reader')).toBeVisible();
  });

  it('shows the name of the table an access request names', async () => {
    await setup([accessProposal('dataStore')]);

    expect(await screen.findByText('Release table')).toBeVisible();
  });

  it('approves a proposal through a button named after its manager, and removes the card', async () => {
    const { api, events } = await setup([accessProposal()]);

    await userEvent.click(screen.getByRole('button', { name: 'Approve proposal from Lloyd' }));

    expect(api.decideProposal).toHaveBeenCalledWith('prop-access', { decision: 'approve' });
    await waitFor(() => expect(events.proposals()).toEqual([]));
    expect(screen.queryByTestId('governance-card')).toBeNull();
  });

  it('keeps the Confirm denial button inactive, with a message, until a reason is typed', async () => {
    const { api } = await setup([lawProposal()]);

    await userEvent.click(screen.getByRole('button', { name: 'Deny proposal from Lloyd' }));
    const confirm = screen.getByRole('button', { name: 'Confirm denial' });

    expect(confirm).toBeDisabled();
    expect(screen.getByText('A reason is required (1 to 500 characters).')).toBeVisible();
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason for denying' }), '   ');
    expect(confirm).toBeDisabled();
    expect(api.decideProposal).not.toHaveBeenCalled();
  });

  it('denies with the typed reason and removes the card', async () => {
    const { api, events } = await setup([lawProposal()]);

    await userEvent.click(screen.getByRole('button', { name: 'Deny proposal from Lloyd' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason for denying' }), 'Too broad');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm denial' }));

    expect(api.decideProposal).toHaveBeenCalledWith('prop-law', { decision: 'deny', reason: 'Too broad' });
    await waitFor(() => expect(events.proposals()).toEqual([]));
  });

  it('renders hostile proposal text as inert plain text', async () => {
    const hostile = '<img src=x onerror="window.pwned=1"> **bold** [link](http://evil)';
    await setup([lawProposal({ payload: { text: hostile } })]);

    const card = screen.getByTestId('governance-card');
    expect(within(card).getByText(hostile)).toBeVisible();
    expect(card.querySelector('img, a[href^="http"], strong, script')).toBeNull();
  });

  it('shows bidirectional controls of a proposal as escapes', async () => {
    const rtlOverride = String.fromCharCode(0x202e);
    await setup([lawProposal({ payload: { text: `evil${rtlOverride}txt` } })]);

    expect(screen.getByTestId('governance-card')).toHaveTextContent('evil<U+202E>txt');
  });

  it('tells how to copy an approved law into the mission note, with a link that opens that note', async () => {
    await setup([lawProposal()]);

    await userEvent.click(screen.getByRole('button', { name: 'Approve proposal from Lloyd' }));

    expect(await screen.findByText('Copy this into the Laws section of the mission note.')).toBeVisible();
    const link = screen.getByRole('link', { name: 'Open the mission note of Lloyd' });
    expect(link.getAttribute('href')).toContain('/notes');
    expect(link.getAttribute('href')).toContain('noteId=mission-1');
    expect(screen.queryByRole('button', { name: /Approve proposal/ })).toBeNull();
  });

  it('offers no button that writes into the note', async () => {
    await setup([lawProposal()]);
    await userEvent.click(screen.getByRole('button', { name: 'Approve proposal from Lloyd' }));
    await screen.findByText('Copy this into the Laws section of the mission note.');

    expect(screen.queryByRole('button', { name: /add to (the )?note/i })).toBeNull();
  });

  it.each([
    ['already_resolved', 409, 'This was already decided elsewhere.'],
    ['proposal_not_found', 404, 'That proposal no longer exists.'],
  ])('shows the copy of %s, not the code', async (code, status, copy) => {
    const decideProposal = vi.fn().mockRejectedValue(new ApiError(status, `POST → ${status}`, code));
    await setup([lawProposal()], { decideProposal });

    await userEvent.click(screen.getByRole('button', { name: 'Approve proposal from Lloyd' }));

    expect(await screen.findByText(copy)).toBeVisible();
    expect(screen.queryByText(new RegExp(code))).toBeNull();
  });
});
