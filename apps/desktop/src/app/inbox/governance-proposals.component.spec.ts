import { render, screen, waitFor, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { outputBinding } from '@angular/core';
import { TestBed } from '@angular/core/testing';
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
  readonly onNoCardLeft?: () => void;
}

async function setup(proposals: GovernanceProposalView[], { apiPatch = {}, sessions = [managerSession], managers = [managerView], onNoCardLeft = () => undefined }: SetupOptions = {}) {
  const daemon = await connectToScriptedDaemon({ sessions, managers, proposals });
  const api = {
    decideProposal: vi.fn().mockResolvedValue({}),
    getNote: vi.fn().mockResolvedValue({ id: 'res-uuid-1', title: 'Q4 roadmap' }),
    getDataStore: vi.fn().mockResolvedValue({ id: 'res-uuid-1', displayName: 'Release table' }),
    ...apiPatch,
  };
  const { fixture } = await render(GovernanceProposalsComponent, {
    bindings: [outputBinding('noCardLeft', onNoCardLeft)],
    providers: [provideRouter([]), { provide: FleetApiService, useValue: api }, { provide: FleetEventsService, useValue: daemon.events }],
  });
  return { ...daemon, api, fixture };
}

const lawName = (verb: string, excerpt: string) => `${verb} law proposal from Lloyd: ${excerpt}`;
const cardTexts = () => screen.getAllByTestId('governance-card').map((card) => card.textContent ?? '');
const liveRegion = () => screen.getByRole('status', { name: 'Governance queue' });
const ALREADY_DECIDED_NOTICE_MS = 8_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

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
    it('leaves nothing to copy into the mission note: the law lives in the daemon', async () => {
      const proposal = lawProposal();
      const { resolveOnDaemon, api, fixture } = await setup([proposal]);

      await userEvent.click(screen.getByRole('button', { name: lawName('Approve', 'Never deploy on Friday') }));
      resolveOnDaemon(proposal);
      await waitFor(() => expect(screen.queryByTestId('governance-card')).toBeNull());
      await fixture.whenStable();

      expect(api.decideProposal).toHaveBeenCalledWith('prop-law', { decision: 'approve' });
      expect(screen.queryByText(/Copy this into/)).toBeNull();
      expect(screen.queryByTestId('governance-approved')).toBeNull();
      expect(screen.queryByRole('link', { name: 'Open the mission note of Lloyd' })).toBeNull();
    });

    it('keeps nothing of the approved law in the session storage', async () => {
      const proposal = lawProposal();
      const { resolveOnDaemon, fixture } = await setup([proposal]);

      await userEvent.click(screen.getByRole('button', { name: lawName('Approve', 'Never deploy on Friday') }));
      resolveOnDaemon(proposal);
      await fixture.whenStable();

      expect(sessionStorage.getItem('openfleet.governance.approved-texts.v1')).toBeNull();
    });
  });

  describe('approved text kept for the human', () => {
    const approvePermission = async () => {
      const proposal = permissionProposal();
      const view = await setup([proposal]);
      await userEvent.click(screen.getByRole('button', { name: /^Approve permission proposal/ }));
      view.resolveOnDaemon(proposal);
      await screen.findByTestId('governance-approved');
      return view;
    };

    const reloadThePage = async (view: Awaited<ReturnType<typeof setup>>) => {
      view.fixture.destroy();
      TestBed.resetTestingModule();
      return setup([]);
    };

    it('shows the approved permission again after the page is reloaded', async () => {
      const view = await approvePermission();

      await reloadThePage(view);

      const approved = screen.getByTestId('governance-approved');
      expect(approved).toHaveTextContent('Approved for Lloyd');
      expect(approved).toHaveTextContent('git tag');
      expect(screen.getByRole('link', { name: 'Open the mission note of Lloyd' }).getAttribute('href')).toContain('noteId=mission-1');
    });

    it('does not show an approved text again after it was dismissed and the page reloaded', async () => {
      const view = await approvePermission();
      await userEvent.click(screen.getByRole('button', { name: /^Dismiss permission proposal/ }));

      await reloadThePage(view);

      expect(screen.queryByTestId('governance-approved')).toBeNull();
    });

    it('ignores the law texts an older version left in the session storage, and keeps the permission ones', async () => {
      const storedItem = (kind: string, id: string) => ({ proposalId: id, managerName: 'Lloyd', kind, typeLabel: kind, excerpt: id, text: `Text of ${id}`, noteQuery: null });
      sessionStorage.setItem('openfleet.governance.approved-texts.v1', JSON.stringify({ version: 1, items: [storedItem('law', 'old-law'), storedItem('permission', 'old-permission')] }));

      await setup([]);

      expect(screen.getAllByTestId('governance-approved')).toHaveLength(1);
      expect(screen.getByText('Text of old-permission')).toBeVisible();
      expect(screen.queryByText('Text of old-law')).toBeNull();
      expect(screen.queryByText('Copy this into the Laws section of the mission note.')).toBeNull();
    });

    it('does not rewrite the stored law texts of an older version', async () => {
      const law = { proposalId: 'old-law', managerName: 'Lloyd', kind: 'law', typeLabel: 'law', excerpt: 'x', text: 'Text of old-law', noteQuery: null };
      sessionStorage.setItem('openfleet.governance.approved-texts.v1', JSON.stringify({ version: 1, items: [law] }));
      const proposal = permissionProposal();
      const { resolveOnDaemon } = await setup([proposal]);

      await userEvent.click(screen.getByRole('button', { name: /^Approve permission proposal/ }));
      resolveOnDaemon(proposal);
      await screen.findByTestId('governance-approved');

      expect(sessionStorage.getItem('openfleet.governance.approved-texts.v1')).not.toContain('old-law');
    });

    it('tells a permission to be copied into the mission note where the standing permissions are written', async () => {
      const proposal = permissionProposal();
      const { resolveOnDaemon } = await setup([proposal]);
      await userEvent.click(screen.getByRole('button', { name: /^Approve permission proposal/ }));

      resolveOnDaemon(proposal);

      expect(await screen.findByText('Copy this into the mission note, where your standing permissions are written.')).toBeVisible();
      expect(screen.queryByText('Copy this into the Laws section of the mission note.')).toBeNull();
    });

    it('keeps the permission instruction after the page is reloaded', async () => {
      const proposal = permissionProposal();
      const view = await setup([proposal]);
      await userEvent.click(screen.getByRole('button', { name: /^Approve permission proposal/ }));
      view.resolveOnDaemon(proposal);
      await screen.findByTestId('governance-approved');

      await reloadThePage(view);

      expect(screen.getByText('Copy this into the mission note, where your standing permissions are written.')).toBeVisible();
    });

    it('ignores stored text that does not have the expected shape', async () => {
      sessionStorage.setItem('openfleet.governance.approved-texts.v1', JSON.stringify({ version: 1, items: [{ proposalId: 'x', text: 42, extra: true }] }));

      await setup([]);

      expect(screen.queryByTestId('governance-approved')).toBeNull();
    });

    it('ignores stored text that is not JSON', async () => {
      sessionStorage.setItem('openfleet.governance.approved-texts.v1', '{not json');

      await setup([]);

      expect(screen.queryByTestId('governance-approved')).toBeNull();
    });

    it('keeps at most the 20 latest approved texts across a reload', async () => {
      const stored = Array.from({ length: 25 }, (_, index) => ({
        proposalId: `p${index}`, managerName: 'Lloyd', kind: 'permission', typeLabel: 'permission', excerpt: `Permission ${index}`, text: `Permission ${index}`, noteQuery: null,
      }));
      sessionStorage.setItem('openfleet.governance.approved-texts.v1', JSON.stringify({ version: 1, items: stored }));
      const view = await setup([]);
      const proposal = { ...permissionProposal({ action: 'newest action' }), id: 'newest' };
      view.proposeOnDaemon(proposal);
      await userEvent.click(await screen.findByRole('button', { name: /^Approve permission proposal/ }));
      view.resolveOnDaemon(proposal);
      await screen.findByText(/newest action/);

      await reloadThePage(view);

      expect(screen.getAllByTestId('governance-approved')).toHaveLength(20);
      expect(screen.getByText(/newest action/)).toBeVisible();
    });

    it('still shows the approved text when the browser refuses any storage', async () => {
      const refuse = () => { throw new Error('denied'); };
      vi.stubGlobal('sessionStorage', { getItem: refuse, setItem: refuse, removeItem: refuse, clear: refuse });
      const proposal = permissionProposal();
      const { resolveOnDaemon } = await setup([proposal]);
      await userEvent.click(screen.getByRole('button', { name: /^Approve permission proposal/ }));

      resolveOnDaemon(proposal);

      expect(await screen.findByText('Copy this into the mission note, where your standing permissions are written.')).toBeVisible();
    });

    it('moves the focus to the next approved text when one is dismissed', async () => {
      const permissionA = { ...permissionProposal({ action: 'action A' }), id: 'a', createdAt: '2026-10-14T10:00:00.000Z' };
      const permissionB = { ...permissionProposal({ action: 'action B' }), id: 'b', createdAt: '2026-10-14T10:01:00.000Z' };
      const { resolveOnDaemon } = await setup([permissionA, permissionB]);
      await userEvent.click(screen.getByRole('button', { name: /^Approve permission proposal from Lloyd: action A/ }));
      resolveOnDaemon(permissionA);
      await userEvent.click(await screen.findByRole('button', { name: /^Approve permission proposal from Lloyd: action B/ }));
      resolveOnDaemon(permissionB);
      await waitFor(() => expect(screen.getAllByTestId('governance-approved')).toHaveLength(2));

      await userEvent.click(screen.getByRole('button', { name: /^Dismiss permission proposal from Lloyd: action A/ }));

      await waitFor(() => expect(within(screen.getByTestId('governance-approved')).getByRole('link', { name: 'Open the mission note of Lloyd' })).toHaveFocus());
    });

    it('hands the focus back to the Inbox when the last approved text is dismissed', async () => {
      const onNoCardLeft = vi.fn();
      const proposal = permissionProposal();
      const { resolveOnDaemon, fixture } = await setup([proposal], { onNoCardLeft });
      await userEvent.click(screen.getByRole('button', { name: /^Approve permission proposal/ }));
      resolveOnDaemon(proposal);
      const dismiss = await screen.findByRole('button', { name: /^Dismiss permission proposal/ });
      await fixture.whenStable();
      onNoCardLeft.mockClear();

      await userEvent.click(dismiss);

      await waitFor(() => expect(onNoCardLeft).toHaveBeenCalledTimes(1));
    });
  });

  describe('a decision lost to another decider', () => {
    const alreadyResolved = () => new ApiError(409, 'POST → 409', 'already_resolved');

    async function approveAfterSomeoneElseDecided() {
      const decideProposal = vi.fn().mockRejectedValue(alreadyResolved());
      const view = await setup([lawProposal()], { apiPatch: { decideProposal } });
      const user = userEvent.setup({ delay: null });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await user.click(screen.getByRole('button', { name: lawName('Approve', 'Never deploy on Friday') }));
      await view.fixture.whenStable();
      return { ...view, user };
    }

    it('says in the live region that it was decided elsewhere, naming the manager and the type', async () => {
      await approveAfterSomeoneElseDecided();

      expect(liveRegion()).toHaveTextContent('Already decided elsewhere');
      expect(liveRegion()).toHaveTextContent('law proposal from Lloyd');
    });

    it('still tells it once the daemon has taken the card away', async () => {
      const proposal = lawProposal();
      const view = await approveAfterSomeoneElseDecided();

      view.resolveOnDaemon(proposal, 'denied');
      await view.fixture.whenStable();

      expect(screen.queryByTestId('governance-card')).toBeNull();
      expect(liveRegion()).toHaveTextContent('Already decided elsewhere');
    });

    it('lets the message go by itself after a few seconds', async () => {
      const view = await approveAfterSomeoneElseDecided();

      await vi.advanceTimersByTimeAsync(ALREADY_DECIDED_NOTICE_MS);
      await view.fixture.whenStable();

      expect(liveRegion()).not.toHaveTextContent('Already decided elsewhere');
    });

    it('lets the message go at the next action', async () => {
      const view = await approveAfterSomeoneElseDecided();

      await view.user.click(screen.getByRole('button', { name: lawName('Deny', 'Never deploy on Friday') }));
      await view.fixture.whenStable();

      expect(liveRegion()).not.toHaveTextContent('Already decided elsewhere');
    });

    it('says nothing of the kind for another failure', async () => {
      const decideProposal = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      await setup([lawProposal()], { apiPatch: { decideProposal } });

      await userEvent.click(screen.getByRole('button', { name: lawName('Approve', 'Never deploy on Friday') }));
      await screen.findByText(/Can’t reach the OpenFleet daemon/);

      expect(liveRegion()).not.toHaveTextContent('Already decided elsewhere');
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

    it('renders a hostile approved permission as inert plain text', async () => {
      const proposal = permissionProposal({ action: HOSTILE_MARKUP });
      const { resolveOnDaemon } = await setup([proposal]);
      await userEvent.click(screen.getByRole('button', { name: /^Approve permission proposal/ }));
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

    describe('cancelling a denial', () => {
      const lawA = lawProposal({ id: 'a', payload: { text: 'Law A' }, createdAt: '2026-10-14T10:00:00.000Z' });
      const lawB = lawProposal({ id: 'b', payload: { text: 'Law B' }, createdAt: '2026-10-14T10:01:00.000Z' });

      it('gives the focus back to the Deny button of the same card when Cancel is pressed', async () => {
        await setup([lawA, lawB]);
        await userEvent.click(screen.getByRole('button', { name: lawName('Deny', 'Law A') }));

        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.getByRole('button', { name: lawName('Deny', 'Law A') })).toHaveFocus());
      });

      it('closes the denial form and gives the focus back to the Deny button of the same card when Escape is pressed in the reason', async () => {
        await setup([lawA, lawB]);
        await userEvent.click(screen.getByRole('button', { name: lawName('Deny', 'Law A') }));
        await userEvent.type(screen.getByRole('textbox', { name: 'Reason for denying' }), 'Too broad');

        await userEvent.keyboard('{Escape}');

        await waitFor(() => expect(screen.getByRole('button', { name: lawName('Deny', 'Law A') })).toHaveFocus());
        expect(screen.queryByRole('textbox', { name: 'Reason for denying' })).toBeNull();
      });

      it('forgets the draft reason of the card whose denial was cancelled with Escape', async () => {
        const { api } = await setup([lawA, lawB]);
        await userEvent.click(screen.getByRole('button', { name: lawName('Deny', 'Law A') }));
        await userEvent.type(screen.getByRole('textbox', { name: 'Reason for denying' }), 'Too broad');
        await userEvent.keyboard('{Escape}');

        await userEvent.click(await screen.findByRole('button', { name: lawName('Deny', 'Law A') }));

        expect(screen.getByRole('textbox', { name: 'Reason for denying' })).toHaveValue('');
        expect(api.decideProposal).not.toHaveBeenCalled();
      });

      it('closes the denial form when Escape is pressed on its Cancel button', async () => {
        await setup([lawA, lawB]);
        await userEvent.click(screen.getByRole('button', { name: lawName('Deny', 'Law A') }));
        screen.getByRole('button', { name: 'Cancel' }).focus();

        await userEvent.keyboard('{Escape}');

        await waitFor(() => expect(screen.getByRole('button', { name: lawName('Deny', 'Law A') })).toHaveFocus());
      });
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
