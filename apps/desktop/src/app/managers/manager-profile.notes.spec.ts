import { signal } from '@angular/core';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import type { ManagerProfile, ManagerView, Page, Project } from '@openfleet/shared';
import { EMPTY, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { ManagerDashboardComponent } from './manager-dashboard.component';

const FLEET: Project = { id: 'p-fleet', name: 'Fleet', docsFolderPath: null };
const STALE_PROFILE_TEXT = 'This profile changed since you opened it. Reload it.';

const sessionOf = () => ({
  id: 'm1', name: 'Capitaine', emoji: '🧭', role: 'manager', state: 'closed', harness: 'claude-cli', model: 'sonnet', projectId: FLEET.id, stateSince: new Date().toISOString(),
});

const managerViewOf = (overrides: Partial<ManagerView> = {}): ManagerView => ({
  sessionId: 'm1', pulseSeconds: 600, pulseEnabled: true, childrenCap: 4, missionText: '# Run the fleet', nextPulseAt: new Date(Date.now() + 60_000).toISOString(), childrenCount: 0,
  expertise: 'Release trains', pulseActions: ['Check CI', 'Unblock reviews'], profileRev: 3, ...overrides,
});

const profileOf = (overrides: Partial<ManagerView> = {}): ManagerProfile => ({ manager: managerViewOf(overrides), scapeImport: 'not_imported' });
const pageOf = <T>(items: T[]): Page<T> => ({ items, total: items.length, limit: 200, offset: 0 });
const staleRevision = () => new ApiError(409, 'refused: stale_revision', 'stale_revision');

function fakeApi({ profile = profileOf(), updateManager = vi.fn().mockResolvedValue(managerViewOf()) } = {}) {
  return {
    getManagerProfile: vi.fn().mockResolvedValue(profile),
    updateManager,
    getManagerGovernance: () => Promise.resolve({ resourceGrants: [], pending: [], queued: [], denied: [], history: [], governanceEvictedDenials: 0 }),
    reopenSession: vi.fn().mockResolvedValue({}),
    listProjects: vi.fn().mockResolvedValue(pageOf([FLEET])),
    pulseNow: vi.fn().mockResolvedValue({ pulsed: true }),
    models: vi.fn().mockResolvedValue({}),
  };
}

async function openProfile(api = fakeApi()) {
  const liveManagers = signal<ManagerView[]>([managerViewOf()]);
  const events = {
    sessions: signal([sessionOf()]), approvals: signal([]), proposals: signal([]), queuedCountOf: () => 0, reconnectCount: signal(0), lawChanges: EMPTY, managers: liveManagers, snapshotReceived: signal(true),
    workingStates: signal(new Map()), workingStatesReported: signal(false), workingStateMaxAgeMinutes: signal<number | undefined>(30), workingStateMaxBytes: signal<number | undefined>(6144),
  };
  await render(ManagerDashboardComponent, {
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: 'm1' })) } },
      { provide: FleetEventsService, useValue: events },
      { provide: FleetApiService, useValue: api },
    ],
  });
  await screen.findByRole('button', { name: 'Save' });
  const managerAnnouncesItsProfile = (manager: ManagerView) => liveManagers.set([manager]);
  return { api, managerAnnouncesItsProfile };
}

const expertiseField = () => screen.getByRole('textbox', { name: 'Expertise' });
const actionFields = () => screen.getAllByRole('textbox', { name: /^Pulse action \d+$/ });
const save = () => userEvent.click(screen.getByRole('button', { name: 'Save' }));
const replaceText = async (field: HTMLElement, text: string) => {
  await userEvent.clear(field);
  await userEvent.click(field);
  await userEvent.paste(text);
};

describe('the expertise and the pulse actions of the manager', () => {
  describe('reading them', () => {
    it('user reads the expertise and each pulse action in the form', async () => {
      await openProfile();

      expect(expertiseField()).toHaveValue('Release trains');
      expect(actionFields().map((field) => (field as HTMLInputElement).value)).toEqual(['Check CI', 'Unblock reviews']);
    });

    it('user sees how many characters of the expertise are used', async () => {
      await openProfile();

      expect(screen.getByTestId('manager-expertise-count')).toHaveTextContent('14 / 500');
    });

    it('user finds an empty form, without error, from a daemon that does not report them', async () => {
      await openProfile(fakeApi({ profile: profileOf({ expertise: undefined, pulseActions: undefined, profileRev: undefined }) }));

      expect(expertiseField()).toHaveValue('');
      expect(screen.queryAllByRole('textbox', { name: /^Pulse action \d+$/ })).toHaveLength(0);
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  describe('editing and saving them', () => {
    it('user rewrites the expertise, adds an action, and saves both with the revision they read', async () => {
      const { api } = await openProfile();

      await replaceText(expertiseField(), 'Incident response');
      await userEvent.click(screen.getByRole('button', { name: 'Add pulse action' }));
      await userEvent.type(actionFields()[2]!, 'Page the on-call');
      await save();

      await waitFor(() => expect(api.updateManager).toHaveBeenCalledWith('m1', {
        expertise: 'Incident response', pulseActions: ['Check CI', 'Unblock reviews', 'Page the on-call'], expectedProfileRev: 3,
      }));
    });

    it('user removes an action and saves the shorter list', async () => {
      const { api } = await openProfile();

      await userEvent.click(screen.getByRole('button', { name: 'Remove pulse action 1' }));
      await save();

      await waitFor(() => expect(api.updateManager).toHaveBeenCalledWith('m1', { pulseActions: ['Unblock reviews'], expectedProfileRev: 3 }));
    });

    it('user clears the expertise and saves the empty text', async () => {
      const { api } = await openProfile();

      await userEvent.clear(expertiseField());
      await save();

      await waitFor(() => expect(api.updateManager).toHaveBeenCalledWith('m1', { expertise: '', expectedProfileRev: 3 }));
    });

    it('user sees the changed fields counted', async () => {
      await openProfile();

      await replaceText(expertiseField(), 'Incident response');

      expect(screen.getByTestId('manager-changes-count')).toHaveTextContent('1 changed');
    });

    it('user saving only the children cap sends neither the profile text nor its revision', async () => {
      const { api } = await openProfile();

      await userEvent.click(screen.getByRole('button', { name: 'Increase children cap' }));
      await save();

      await waitFor(() => expect(api.updateManager).toHaveBeenCalledWith('m1', { childrenCap: 5 }));
    });

    it('user saving against a daemon that reports no revision sends no revision', async () => {
      const { api } = await openProfile(fakeApi({ profile: profileOf({ profileRev: undefined }) }));

      await replaceText(expertiseField(), 'Incident response');
      await save();

      await waitFor(() => expect(api.updateManager).toHaveBeenCalledWith('m1', { expertise: 'Incident response' }));
    });
  });

  describe('the bounds', () => {
    it('user cannot save an expertise of 501 characters and is told the limit, and nothing is sent', async () => {
      const { api } = await openProfile();

      await replaceText(expertiseField(), 'e'.repeat(501));
      await save();

      expect(screen.getByTestId('manager-expertise-count')).toHaveTextContent('501 / 500');
      expect(await screen.findByText('Expertise must be at most 500 characters')).toBeInTheDocument();
      expect(api.updateManager).not.toHaveBeenCalled();
    });

    it('user can save an expertise of exactly 500 characters', async () => {
      const { api } = await openProfile();

      await replaceText(expertiseField(), 'e'.repeat(500));
      await save();

      await waitFor(() => expect(api.updateManager).toHaveBeenCalledWith('m1', { expertise: 'e'.repeat(500), expectedProfileRev: 3 }));
    });

    it('user cannot save a blank action and is told to write it or remove it', async () => {
      const { api } = await openProfile();

      await userEvent.click(screen.getByRole('button', { name: 'Add pulse action' }));
      await save();

      expect(await screen.findByText('Write the action or remove it')).toBeInTheDocument();
      expect(api.updateManager).not.toHaveBeenCalled();
    });

    it('user cannot save an action of 281 characters', async () => {
      const { api } = await openProfile();

      await replaceText(actionFields()[0]!, 'a'.repeat(281));
      await save();

      expect(await screen.findByText('An action must be at most 280 characters')).toBeInTheDocument();
      expect(api.updateManager).not.toHaveBeenCalled();
    });

    it('user cannot save the same action twice, even with other spaces around it', async () => {
      const { api } = await openProfile();

      await replaceText(actionFields()[1]!, '  Check CI ');
      await save();

      expect(await screen.findByText('This action is already in the list')).toBeInTheDocument();
      expect(api.updateManager).not.toHaveBeenCalled();
    });

    it('user cannot add a thirteenth action and is told why', async () => {
      const twelveActions = Array.from({ length: 12 }, (_, index) => `Action ${index + 1}`);
      await openProfile(fakeApi({ profile: profileOf({ pulseActions: twelveActions }) }));

      expect(screen.getByRole('button', { name: 'Add pulse action' })).toBeDisabled();
      expect(screen.getByTestId('manager-pulse-actions-count')).toHaveTextContent('12 / 12');
    });
  });

  describe('when the profile changed under the form', () => {
    const staleApi = () => fakeApi({ updateManager: vi.fn().mockRejectedValueOnce(staleRevision()).mockResolvedValue(managerViewOf({ profileRev: 5 })) });

    it('user reads that the profile changed and to reload it, and keeps what they typed', async () => {
      await openProfile(staleApi());

      await replaceText(expertiseField(), 'Incident response');
      await save();

      expect(await screen.findByRole('alert')).toHaveTextContent(STALE_PROFILE_TEXT);
      expect(expertiseField()).toHaveValue('Incident response');
    });

    it('user reloads the profile without losing what they typed, then saves it against the new revision', async () => {
      const api = staleApi();
      await openProfile(api);
      await replaceText(expertiseField(), 'Incident response');
      await save();
      await screen.findByRole('alert');
      api.getManagerProfile.mockResolvedValue(profileOf({ expertise: 'Written by the manager', profileRev: 5 }));

      await userEvent.click(screen.getByRole('button', { name: 'Reload profile' }));
      await waitFor(() => expect(screen.queryByText(STALE_PROFILE_TEXT)).toBeNull());
      await save();

      expect(expertiseField()).toHaveValue('Incident response');
      await waitFor(() => expect(api.updateManager).toHaveBeenLastCalledWith('m1', { expertise: 'Incident response', expectedProfileRev: 5 }));
    });

    it('user reloading keeps the action they removed, whatever the manager wrote meanwhile', async () => {
      const api = staleApi();
      await openProfile(api);
      await userEvent.click(screen.getByRole('button', { name: 'Remove pulse action 1' }));
      await save();
      await screen.findByRole('alert');
      api.getManagerProfile.mockResolvedValue(profileOf({ pulseActions: ['Check CI', 'Unblock reviews', 'Read the inbox'], profileRev: 5 }));

      await userEvent.click(screen.getByRole('button', { name: 'Reload profile' }));

      await waitFor(() => expect(screen.queryByText(STALE_PROFILE_TEXT)).toBeNull());
      expect(actionFields()).toHaveLength(1);
    });
  });

  describe('when the manager edits its own profile by MCP', () => {
    it('user reads the new expertise at once when the form holds no draft', async () => {
      const { managerAnnouncesItsProfile } = await openProfile();

      managerAnnouncesItsProfile(managerViewOf({ expertise: 'Written by the manager', pulseActions: ['Read the inbox'], profileRev: 4 }));

      await waitFor(() => expect(expertiseField()).toHaveValue('Written by the manager'));
      expect(actionFields().map((field) => (field as HTMLInputElement).value)).toEqual(['Read the inbox']);
    });

    it('user keeps the draft they are typing, and is told the profile changed', async () => {
      const { managerAnnouncesItsProfile } = await openProfile();
      await replaceText(expertiseField(), 'Incident response');

      managerAnnouncesItsProfile(managerViewOf({ expertise: 'Written by the manager', profileRev: 4 }));

      expect(await screen.findByText(STALE_PROFILE_TEXT)).toBeInTheDocument();
      expect(expertiseField()).toHaveValue('Incident response');
    });

    it('user keeps a mission draft when the manager changes its expertise', async () => {
      const { managerAnnouncesItsProfile } = await openProfile();
      await replaceText(screen.getByRole('textbox', { name: 'Mission' }), 'Ship the roadmap.');

      managerAnnouncesItsProfile(managerViewOf({ expertise: 'Written by the manager', profileRev: 4 }));

      await waitFor(() => expect(expertiseField()).toHaveValue('Written by the manager'));
      expect(screen.getByRole('textbox', { name: 'Mission' })).toHaveValue('Ship the roadmap.');
    });

    it('user sees nothing change when a pulse announces the same revision', async () => {
      const { managerAnnouncesItsProfile } = await openProfile();
      await replaceText(expertiseField(), 'Incident response');

      managerAnnouncesItsProfile(managerViewOf());

      expect(screen.queryByText(STALE_PROFILE_TEXT)).toBeNull();
      expect(expertiseField()).toHaveValue('Incident response');
    });
  });
});
