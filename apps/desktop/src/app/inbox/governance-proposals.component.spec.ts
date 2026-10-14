import { render, screen, waitFor, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { provideRouter } from '@angular/router';
import type { GovernanceProposalView, ManagerView, ResourceAccess, Session } from '@openfleet/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { connectToScriptedDaemon } from './governance-events-harness';
import { GovernanceProposalsComponent } from './governance-proposals.component';

const MANAGER_ID = 'm1';
const PROJECT_ID = 'p1';
const MINUTE_MS = 60_000;
const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const WORD_JOINER = String.fromCharCode(0x2060);
const HOSTILE_MARKUP = '<img src=x onerror="window.pwned=1"> **bold** [link](http://evil)';

const lawProposal = (patch: Partial<GovernanceProposalView> = {}): GovernanceProposalView => ({
  id: 'prop-law', managerId: MANAGER_ID, kind: 'law', status: 'pending', incident: 'Deploy broke twice',
  payload: { text: 'Never deploy on Friday' }, createdAt: new Date(Date.now() - 5 * MINUTE_MS).toISOString(), ...patch,
});

const permissionProposal = (payload: Record<string, string> = {}): GovernanceProposalView => ({
  id: 'prop-perm', managerId: MANAGER_ID, kind: 'permission', status: 'pending', incident: 'Needs to tag releases',
  payload: { action: 'git tag', scope: 'release branches', condition: 'CI is green', exclusions: 'hotfix branches', ...payload }, createdAt: new Date().toISOString(),
});

const accessProposal = (patch: { resourceType?: 'note' | 'dataStore'; access?: ResourceAccess; role?: string } = {}): GovernanceProposalView => ({
  id: 'prop-access', managerId: MANAGER_ID, kind: 'resourceAccess', status: 'pending', incident: 'Reads the roadmap',
  payload: { resourceType: patch.resourceType ?? 'note', resourceId: 'res-uuid-1', access: patch.access ?? 'read', role: patch.role ?? 'reader' }, createdAt: new Date().toISOString(),
});

const managerSession = { id: MANAGER_ID, name: 'Lloyd', emoji: '🧭', state: 'idle', role: 'manager', projectId: PROJECT_ID } as Session;
const managerView = { sessionId: MANAGER_ID, missionNoteId: 'mission-1' } as ManagerView;

interface SetupOptions {
  readonly apiPatch?: Record<string, unknown>;
  readonly sessions?: Session[];
  readonly managers?: ManagerView[];
}

async function setup(proposals: GovernanceProposalView[], { apiPatch = {}, sessions = [managerSession], managers = [managerView] }: SetupOptions = {}) {
  const daemon = await connectToScriptedDaemon({ sessions, managers, proposals });
  const api = {
    decideProposal: vi.fn().mockResolvedValue({}),
    getNote: vi.fn().mockResolvedValue({ id: 'res-uuid-1', title: 'Q4 roadmap' }),
    getDataStore: vi.fn().mockResolvedValue({ id: 'res-uuid-1', displayName: 'Release table' }),
    ...apiPatch,
  };
  await render(GovernanceProposalsComponent, { providers: [provideRouter([]), { provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: daemon.events }] });
  return { ...daemon, api };
}

const lawName = (verb: string, excerpt: string) => `${verb} law proposal from Lloyd: ${excerpt}`;
const cardTexts = () => screen.getAllByTestId('governance-card').map((card) => card.textContent ?? '');

afterEach(() => vi.unstubAllGlobals());

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
    await setup([accessProposal()]);

    expect(await screen.findByText('Q4 roadmap')).toBeVisible();
    expect(screen.queryByText('res-uuid-1')).toBeNull();
    expect(screen.getByText('Read')).toBeVisible();
    expect(screen.getByText('reader')).toBeVisible();
  });

  it('shows the name of the table an access request names', async () => {
    await setup([accessProposal({ resourceType: 'dataStore' })]);

    expect(await screen.findByText('Release table')).toBeVisible();
  });

  it.each([
    ['readWrite', 'Read and write'],
    ['append', 'Append'],
    ['run', 'Run'],
    ['use', 'Use'],
  ] as const)('shows the access %s as "%s"', async (access, label) => {
    await setup([accessProposal({ access })]);

    expect(screen.getByText(label)).toBeVisible();
    expect(screen.queryByText(access)).toBeNull();
  });

  describe('deciding', () => {
    it('sends the approval from a button named after the type, the manager and the start of the text', async () => {
      const { api } = await setup([lawProposal()]);

      await userEvent.click(screen.getByRole('button', { name: lawName('Approve', 'Never deploy on Friday') }));

      expect(api.decideProposal).toHaveBeenCalledWith('prop-law', { decision: 'approve' });
    });

    it('names the buttons of a text longer than 40 characters after its first 40 characters', async () => {
      const longText = 'Never deploy on a Friday afternoon, not even a hotfix';
      await setup([lawProposal({ payload: { text: longText } })]);

      expect(screen.getByRole('button', { name: lawName('Approve', `${longText.slice(0, 40)}…`) })).toBeVisible();
      expect(screen.getByRole('button', { name: lawName('Deny', `${longText.slice(0, 40)}…`) })).toBeVisible();
    });

    it('names the buttons of a permission after its action and of an access request after its resource', async () => {
      await setup([permissionProposal(), { ...accessProposal(), id: 'prop-access' }]);

      expect(screen.getByRole('button', { name: 'Approve permission proposal from Lloyd: git tag' })).toBeVisible();
      expect(await screen.findByRole('button', { name: 'Approve resource access proposal from Lloyd: Q4 roadmap' })).toBeVisible();
    });

    it('keeps the card until the daemon announces the decision, then removes it', async () => {
      const proposal = accessProposal();
      const { resolveOnDaemon } = await setup([proposal]);

      await userEvent.click(screen.getByRole('button', { name: /^Approve resource access proposal/ }));
      await waitFor(() => expect(screen.getByRole('button', { name: /^Approve resource access proposal/ })).toBeEnabled());

      expect(screen.getByTestId('governance-card')).toBeVisible();
      resolveOnDaemon(proposal);
      await waitFor(() => expect(screen.queryByTestId('governance-card')).toBeNull());
    });

    it('keeps the Confirm denial button inactive, with a message, until a reason is typed', async () => {
      const { api } = await setup([lawProposal()]);

      await userEvent.click(screen.getByRole('button', { name: lawName('Deny', 'Never deploy on Friday') }));
      const confirm = screen.getByRole('button', { name: 'Confirm denial' });

      expect(confirm).toBeDisabled();
      expect(screen.getByText('A reason is required (1 to 500 characters).')).toBeVisible();
      expect(api.decideProposal).not.toHaveBeenCalled();
    });

    it.each([
      ['spaces only', '   '],
      ['invisible characters only', `${ZERO_WIDTH_SPACE}${WORD_JOINER} ${ZERO_WIDTH_SPACE}`],
    ])('keeps Confirm denial inactive for a reason of %s', async (_label, blankReason) => {
      const { api } = await setup([lawProposal()]);

      await userEvent.click(screen.getByRole('button', { name: lawName('Deny', 'Never deploy on Friday') }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Reason for denying' }), blankReason);

      expect(screen.getByRole('button', { name: 'Confirm denial' })).toBeDisabled();
      expect(api.decideProposal).not.toHaveBeenCalled();
    });

    it('sends at most 500 characters of a longer reason', async () => {
      const { api } = await setup([lawProposal()]);
      await userEvent.click(screen.getByRole('button', { name: lawName('Deny', 'Never deploy on Friday') }));

      await userEvent.click(screen.getByRole('textbox', { name: 'Reason for denying' }));
      await userEvent.paste('x'.repeat(501));
      await userEvent.click(screen.getByRole('button', { name: 'Confirm denial' }));

      expect(api.decideProposal).toHaveBeenCalledWith('prop-law', { decision: 'deny', reason: 'x'.repeat(500) });
    });

    it('denies with the typed reason, then removes the card once the daemon announces it', async () => {
      const proposal = lawProposal();
      const { api, resolveOnDaemon } = await setup([proposal]);

      await userEvent.click(screen.getByRole('button', { name: lawName('Deny', 'Never deploy on Friday') }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Reason for denying' }), 'Too broad');
      await userEvent.click(screen.getByRole('button', { name: 'Confirm denial' }));

      expect(api.decideProposal).toHaveBeenCalledWith('prop-law', { decision: 'deny', reason: 'Too broad' });
      resolveOnDaemon(proposal, 'denied');
      await waitFor(() => expect(screen.queryByTestId('governance-card')).toBeNull());
    });

    it('sends one request for two clicks on Approve before the screen redraws', async () => {
      const decideProposal = vi.fn().mockReturnValue(new Promise(() => undefined));
      await setup([lawProposal()], { apiPatch: { decideProposal } });
      const approve = screen.getByRole('button', { name: lawName('Approve', 'Never deploy on Friday') });

      approve.click();
      approve.click();

      expect(decideProposal).toHaveBeenCalledTimes(1);
    });

    it('sends one request for two clicks on Confirm denial before the screen redraws', async () => {
      const decideProposal = vi.fn().mockReturnValue(new Promise(() => undefined));
      await setup([lawProposal()], { apiPatch: { decideProposal } });
      await userEvent.click(screen.getByRole('button', { name: lawName('Deny', 'Never deploy on Friday') }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Reason for denying' }), 'Too broad');
      const confirm = screen.getByRole('button', { name: 'Confirm denial' });

      confirm.click();
      confirm.click();

      expect(decideProposal).toHaveBeenCalledTimes(1);
    });

    it('keeps the reason typed on a card when another card is approved', async () => {
      const lawA = lawProposal({ id: 'a', payload: { text: 'Law A' }, createdAt: '2026-10-14T10:00:00.000Z' });
      const lawB = lawProposal({ id: 'b', payload: { text: 'Law B' }, createdAt: '2026-10-14T10:01:00.000Z' });
      const { resolveOnDaemon } = await setup([lawA, lawB]);
      await userEvent.click(screen.getByRole('button', { name: lawName('Deny', 'Law B') }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Reason for denying' }), 'keep this');

      await userEvent.click(screen.getByRole('button', { name: lawName('Approve', 'Law A') }));
      resolveOnDaemon(lawA);

      await waitFor(() => expect(screen.getAllByTestId('governance-card')).toHaveLength(1));
      expect(screen.getByRole('textbox', { name: 'Reason for denying' })).toHaveValue('keep this');
    });

    it.each([
      ['already_resolved', 409, 'This was already decided elsewhere.'],
      ['proposal_not_found', 404, 'That proposal no longer exists.'],
    ])('keeps the card and shows the copy of %s, not the code', async (code, status, copy) => {
      const decideProposal = vi.fn().mockRejectedValue(new ApiError(status, `POST → ${status}`, code));
      await setup([lawProposal()], { apiPatch: { decideProposal } });

      await userEvent.click(screen.getByRole('button', { name: lawName('Approve', 'Never deploy on Friday') }));

      expect(await screen.findByText(copy)).toBeVisible();
      expect(screen.queryByText(new RegExp(code))).toBeNull();
      expect(screen.getByTestId('governance-card')).toBeVisible();
    });

    it('keeps the card and says the daemon cannot be reached after a network failure', async () => {
      const decideProposal = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      await setup([lawProposal()], { apiPatch: { decideProposal } });

      await userEvent.click(screen.getByRole('button', { name: lawName('Approve', 'Never deploy on Friday') }));

      expect(await screen.findByText(/Can’t reach the OpenFleet daemon/)).toBeVisible();
      expect(screen.queryByText(/Failed to fetch/)).toBeNull();
      expect(screen.getByRole('button', { name: lawName('Approve', 'Never deploy on Friday') })).toBeEnabled();
    });
  });

  describe('approved law', () => {
    it('tells how to copy it into the mission note, with a link that opens that note', async () => {
      const proposal = lawProposal();
      const { resolveOnDaemon } = await setup([proposal]);

      await userEvent.click(screen.getByRole('button', { name: lawName('Approve', 'Never deploy on Friday') }));
      resolveOnDaemon(proposal);

      expect(await screen.findByText('Copy this into the Laws section of the mission note.')).toBeVisible();
      const link = screen.getByRole('link', { name: 'Open the mission note of Lloyd' });
      expect(link.getAttribute('href')).toContain('/notes');
      expect(link.getAttribute('href')).toContain('noteId=mission-1');
    });

    it('offers no button that writes into the note, and a Dismiss that removes the instruction', async () => {
      const proposal = lawProposal();
      const { resolveOnDaemon } = await setup([proposal]);
      await userEvent.click(screen.getByRole('button', { name: lawName('Approve', 'Never deploy on Friday') }));
      resolveOnDaemon(proposal);
      await screen.findByText('Copy this into the Laws section of the mission note.');

      expect(screen.queryByRole('button', { name: /add to (the )?note/i })).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: lawName('Dismiss', 'Never deploy on Friday') }));

      expect(screen.queryByText('Copy this into the Laws section of the mission note.')).toBeNull();
    });
  });

  describe('hostile text', () => {
    it('renders hostile proposal text as inert plain text', async () => {
      await setup([lawProposal({ payload: { text: HOSTILE_MARKUP } })]);

      const card = screen.getByTestId('governance-card');
      expect(within(card).getByText(HOSTILE_MARKUP)).toBeVisible();
      expect(card.querySelector('img, a[href^="http"], strong, script')).toBeNull();
    });

    it('renders a hostile incident as inert plain text', async () => {
      await setup([lawProposal({ incident: HOSTILE_MARKUP })]);

      const card = screen.getByTestId('governance-card');
      expect(card).toHaveTextContent(HOSTILE_MARKUP);
      expect(card.querySelector('img, a[href^="http"], strong, script')).toBeNull();
    });

    it('shows a bidirectional control of the incident as an escape', async () => {
      await setup([lawProposal({ incident: `evil${RIGHT_TO_LEFT_OVERRIDE}txt` })]);

      expect(screen.getByTestId('governance-card')).toHaveTextContent('evil<U+202E>txt');
    });

    it.each(['action', 'scope', 'condition', 'exclusions'])('renders a hostile %s of a permission as inert plain text with its bidirectional control escaped', async (field) => {
      await setup([permissionProposal({ [field]: `${HOSTILE_MARKUP}${RIGHT_TO_LEFT_OVERRIDE}` })]);

      const card = screen.getByTestId('governance-card');
      expect(card).toHaveTextContent('<U+202E>');
      expect(card).toHaveTextContent(HOSTILE_MARKUP);
      expect(card.querySelector('img, a[href^="http"], strong, script')).toBeNull();
    });

    it('renders a hostile role and a hostile resource name as inert plain text', async () => {
      const getNote = vi.fn().mockResolvedValue({ id: 'res-uuid-1', title: `${HOSTILE_MARKUP}${RIGHT_TO_LEFT_OVERRIDE}` });
      await setup([accessProposal({ role: HOSTILE_MARKUP })], { apiPatch: { getNote } });

      await waitFor(() => expect(screen.getByTestId('governance-card')).toHaveTextContent('<U+202E>'));
      const card = screen.getByTestId('governance-card');
      expect(card.querySelector('img, a[href^="http"], strong, script')).toBeNull();
    });

    it('renders a hostile approved law as inert plain text', async () => {
      const proposal = lawProposal({ payload: { text: HOSTILE_MARKUP } });
      const { resolveOnDaemon } = await setup([proposal]);
      await userEvent.click(screen.getByRole('button', { name: /^Approve law proposal/ }));
      resolveOnDaemon(proposal);

      const approved = await screen.findByTestId('governance-approved');
      expect(approved).toHaveTextContent(HOSTILE_MARKUP);
      expect(approved.querySelector('img, a[href^="http"], strong, script')).toBeNull();
    });
  });

  describe('order', () => {
    const lawAt = (id: string, createdAt: string) => lawProposal({ id, payload: { text: `Law ${id}` }, createdAt });

    it('lists the oldest proposal first, whatever order the daemon announced them in', async () => {
      const { proposeOnDaemon } = await setup([lawAt('late', '2026-10-14T10:05:00.000Z')]);

      proposeOnDaemon(lawAt('early', '2026-10-14T10:00:00.000Z'));

      await waitFor(() => expect(cardTexts()).toHaveLength(2));
      expect(cardTexts()[0]).toContain('Law early');
      expect(cardTexts()[1]).toContain('Law late');
    });

    it('breaks a tie of creation time by id, the same way whatever the arrival order', async () => {
      await setup([lawAt('b', '2026-10-14T10:00:00.000Z'), lawAt('a', '2026-10-14T10:00:00.000Z')]);

      expect(cardTexts()[0]).toContain('Law a');
      expect(cardTexts()[1]).toContain('Law b');
    });
  });

  describe('manager that is gone', () => {
    it('never shows the raw id of a manager whose session is unknown', async () => {
      await setup([lawProposal()], { sessions: [], managers: [] });

      expect(within(screen.getByTestId('governance-card')).getByTestId('governance-manager')).toHaveTextContent('Unknown manager');
      expect(screen.getByTestId('governance-card')).not.toHaveTextContent(MANAGER_ID);
    });

    it('says "Closed manager" for a manager the daemon still lists but whose session is gone', async () => {
      await setup([lawProposal()], { sessions: [] });

      expect(within(screen.getByTestId('governance-card')).getByTestId('governance-manager')).toHaveTextContent('Closed manager');
    });
  });

  describe('announcement and focus', () => {
    it('announces how many proposals need the human, from the first render, and follows the decisions', async () => {
      const lawA = lawProposal({ id: 'a', payload: { text: 'Law A' } });
      const lawB = lawProposal({ id: 'b', payload: { text: 'Law B' } });
      const { resolveOnDaemon } = await setup([lawA, lawB]);
      const liveRegion = screen.getByRole('status', { name: 'Governance queue' });

      expect(liveRegion).toHaveTextContent('2 governance proposals need you');
      resolveOnDaemon(lawA);

      await waitFor(() => expect(liveRegion).toHaveTextContent('1 governance proposal needs you'));
    });

    it('moves the focus to the action button of the next card when the card in use leaves', async () => {
      const lawA = lawProposal({ id: 'a', payload: { text: 'Law A' }, createdAt: '2026-10-14T10:00:00.000Z' });
      const lawB = lawProposal({ id: 'b', payload: { text: 'Law B' }, createdAt: '2026-10-14T10:01:00.000Z' });
      const { resolveOnDaemon } = await setup([lawA, lawB]);

      await userEvent.click(screen.getByRole('button', { name: lawName('Approve', 'Law A') }));
      resolveOnDaemon(lawA);

      await waitFor(() => expect(screen.getByRole('button', { name: lawName('Approve', 'Law B') })).toHaveFocus());
    });

    it('moves the focus to the action button of the next card when a denial is cancelled', async () => {
      const lawA = lawProposal({ id: 'a', payload: { text: 'Law A' }, createdAt: '2026-10-14T10:00:00.000Z' });
      const lawB = lawProposal({ id: 'b', payload: { text: 'Law B' }, createdAt: '2026-10-14T10:01:00.000Z' });
      await setup([lawA, lawB]);
      await userEvent.click(screen.getByRole('button', { name: lawName('Deny', 'Law A') }));

      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(screen.getByRole('button', { name: lawName('Approve', 'Law B') })).toHaveFocus());
    });

    it('leaves the focus alone when the card that leaves is not the one in use', async () => {
      const lawA = lawProposal({ id: 'a', payload: { text: 'Law A' }, createdAt: '2026-10-14T10:00:00.000Z' });
      const lawB = lawProposal({ id: 'b', payload: { text: 'Law B' }, createdAt: '2026-10-14T10:01:00.000Z' });
      const { resolveOnDaemon } = await setup([lawA, lawB]);
      screen.getByRole('button', { name: lawName('Approve', 'Law B') }).focus();

      resolveOnDaemon(lawA);

      await waitFor(() => expect(screen.getAllByTestId('governance-card')).toHaveLength(1));
      expect(screen.getByRole('button', { name: lawName('Approve', 'Law B') })).toHaveFocus();
    });
  });
});
