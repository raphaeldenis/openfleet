import { signal } from '@angular/core';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { render, screen, waitFor, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import type { EscalationView, ManagerProfile, ManagerView, Page, Project, ScapeImportStatus } from '@openfleet/shared';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { EMPTY } from 'rxjs';
import { FleetEventsService } from '../core/fleet-events.service';
import { ManagerDashboardComponent } from './manager-dashboard.component';

const emptyGovernance = { resourceGrants: [], pending: [], queued: [], denied: [], history: [], governanceEvictedDenials: 0 };
const governanceApi = { getManagerGovernance: () => Promise.resolve(emptyGovernance) };

const FLEET: Project = { id: 'p-fleet', name: 'Fleet', docsFolderPath: null };
const TEN_MINUTES_AGO = new Date(Date.now() - 10 * 60_000).toISOString();

const MISSION = '# Run the fleet\n\nKeep the backlog moving.\n\n- Spawn at most 4 children\n- Log every decision';

const sessionOf = (overrides: Record<string, unknown> = {}) => ({
  id: 'm1', name: 'Capitaine', emoji: '🧭', role: 'manager', state: 'closed', harness: 'claude-cli', model: 'sonnet', projectId: FLEET.id, stateSince: TEN_MINUTES_AGO, ...overrides,
});

const managerViewOf = (overrides: Partial<ManagerView> = {}): ManagerView => ({
  sessionId: 'm1', pulseSeconds: 600, pulseEnabled: true, childrenCap: 4, missionText: MISSION, nextPulseAt: new Date(Date.now() + 60_000).toISOString(), childrenCount: 0, ...overrides,
});

const profileOf = (overrides: Partial<ManagerView> = {}, scapeImport: ScapeImportStatus = 'not_imported'): ManagerProfile => ({ manager: managerViewOf(overrides), scapeImport });

const pageOf = <T>(items: T[]): Page<T> => ({ items, total: items.length, limit: 200, offset: 0 });

interface ApiOverrides {
  getManagerProfile?: ReturnType<typeof vi.fn>;
  updateManager?: ReturnType<typeof vi.fn>;
  reopenSession?: ReturnType<typeof vi.fn>;
  listProjects?: ReturnType<typeof vi.fn>;
}

function fakeApi(overrides: ApiOverrides = {}) {
  return {
    ...governanceApi,
    getManagerProfile: overrides.getManagerProfile ?? vi.fn().mockResolvedValue(profileOf()),
    updateManager: overrides.updateManager ?? vi.fn().mockResolvedValue(managerViewOf()),
    reopenSession: overrides.reopenSession ?? vi.fn().mockResolvedValue({}),
    listProjects: overrides.listProjects ?? vi.fn().mockResolvedValue(pageOf([FLEET])),
    pulseNow: vi.fn().mockResolvedValue({ pulsed: true }),
    models: vi.fn().mockResolvedValue({}),
  };
}

async function openProfile({ api = fakeApi(), session = sessionOf(), escalations = signal<EscalationView[]>([]) } = {}) {
  const events = {
    sessions: signal([session]), approvals: signal([]), proposals: signal([]), escalations, queuedCountOf: () => 0, reconnectCount: signal(0), lawChanges: EMPTY, managers: signal([managerViewOf()]), snapshotReceived: signal(true),
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
  return api;
}

const factOf = (label: string) => within(screen.getByRole('region', { name: 'Profile' })).getByText(label).closest('div')!;
const apiFailure = (code: string, status = 409) => new ApiError(status, `refused: ${code}`, code);

describe('the manager profile', () => {
  describe('loading the profile', () => {
    it('user sees header and body skeletons until the profile arrives', async () => {
      const never = vi.fn().mockReturnValue(new Promise(() => undefined));

      await openProfile({ api: fakeApi({ getManagerProfile: never }) });

      const loading = screen.getByRole('status', { name: 'Loading the manager profile' });
      expect(loading).toHaveAttribute('aria-busy', 'true');
      expect(within(loading).getByTestId('manager-profile-skeleton-header')).toBeTruthy();
      expect(within(loading).getByTestId('manager-profile-skeleton-body')).toBeTruthy();
      expect(screen.queryByText('Loading the manager profile…')).toBeNull();
    });

    it('user reads a standalone failed-manager card with the reason, and retries from it', async () => {
      const getManagerProfile = vi.fn().mockRejectedValueOnce(apiFailure('stale_revision', 500)).mockResolvedValue(profileOf());
      await openProfile({ api: fakeApi({ getManagerProfile }) });

      const card = await screen.findByRole('alert', { name: 'Manager failed to load' });
      expect(within(card).getByRole('heading', { name: "Couldn't load this manager" })).toBeTruthy();
      expect(within(card).getByTestId('manager-failed-reason').textContent?.trim()).not.toBe('');
      await userEvent.click(within(card).getByRole('button', { name: 'Retry' }));

      expect(await screen.findByRole('region', { name: 'Mission' })).toBeInTheDocument();
    });
  });

  describe('what the user reads about the manager', () => {
    it('user reads the project, harness, model and last activity in the header', async () => {
      await openProfile();

      await waitFor(() => expect(screen.getByTestId('manager-dashboard-project')).toHaveTextContent('Fleet'));
      const meta = screen.getByTestId('manager-dashboard-meta');
      expect(meta).toHaveTextContent('claude-cli');
      expect(meta).toHaveTextContent('sonnet');
      expect(meta).toHaveTextContent('last activity 10 min ago');
    });

    it('user sees the pulse interval, children cap and model as facts', async () => {
      await openProfile();
      await screen.findByRole('region', { name: 'Profile' });

      expect(factOf('Pulse interval')).toHaveTextContent('10 min');
      expect(factOf('Children cap')).toHaveTextContent('4');
      expect(factOf('Model')).toHaveTextContent('sonnet');
    });

    describe('the escalations still waiting for a human answer', () => {
      const escalationOf = (id: string, managerId = 'm1'): EscalationView => ({ id, managerId, ticket: `CCM-${id}`, status: 'pending', body: 'Escalation', createdAt: TEN_MINUTES_AGO, questions: [] });

      it('user sees that the manager has none', async () => {
        await openProfile();
        await screen.findByRole('region', { name: 'Profile' });

        expect(factOf('Open escalations')).toHaveTextContent('0');
      });

      it('user sees how many of this manager wait, not those of another manager', async () => {
        const escalations = signal([escalationOf('1'), escalationOf('2'), escalationOf('3', 'other')]);
        await openProfile({ escalations });
        await screen.findByRole('region', { name: 'Profile' });

        expect(factOf('Open escalations')).toHaveTextContent('2');
      });

      it('user sees the count follow an escalation the daemon announces', async () => {
        const escalations = signal<EscalationView[]>([]);
        await openProfile({ escalations });
        await screen.findByRole('region', { name: 'Profile' });

        escalations.set([escalationOf('1')]);

        await waitFor(() => expect(factOf('Open escalations')).toHaveTextContent('1'));
      });
    });

    it('user still sees the profile, without a project name, when the projects cannot be loaded', async () => {
      await openProfile({ api: fakeApi({ listProjects: vi.fn().mockRejectedValue(new Error('down')) }) });

      await screen.findByRole('region', { name: 'Profile' });

      expect(screen.queryByTestId('manager-dashboard-project')).toBeNull();
    });

    it('user reads the mission as rendered text, not as markdown source', async () => {
      await openProfile();

      const mission = await screen.findByRole('region', { name: 'Mission' });

      expect(within(mission).getByRole('heading', { name: 'Run the fleet' })).toBeInTheDocument();
      expect(within(mission).getAllByRole('listitem').map((item) => item.textContent?.trim())).toEqual(['Spawn at most 4 children', 'Log every decision']);
      expect(mission).not.toHaveTextContent('# Run the fleet');
    });

    it('user is told when the manager has no mission yet', async () => {
      await openProfile({ api: fakeApi({ getManagerProfile: vi.fn().mockResolvedValue(profileOf({ missionText: '' })) }) });

      expect(await screen.findByText('No mission written yet.')).toBeInTheDocument();
    });
  });

  describe('which manager base the manager has read', () => {
    const READ_AT = '2026-10-15T12:00:00.000Z';
    const baseLineOf = () => factOf('Manager base');

    it('user reads that the current base is not read yet', async () => {
      await openProfile({ api: fakeApi({ getManagerProfile: vi.fn().mockResolvedValue(profileOf({ baseVersion: 2 })) }) });
      await screen.findByRole('region', { name: 'Profile' });

      expect(baseLineOf()).toHaveTextContent('Base v2, not read');
    });

    it('user reads the version of the base and the day it was read', async () => {
      const baseRead = { version: 2, sha: 'a'.repeat(64), readAt: READ_AT };
      await openProfile({ api: fakeApi({ getManagerProfile: vi.fn().mockResolvedValue(profileOf({ baseVersion: 2, baseRead })) }) });
      await screen.findByRole('region', { name: 'Profile' });

      expect(baseLineOf()).toHaveTextContent(/^Manager baseBase v2, read on .*2026/);
    });

    it('user reads the new version as not read when the manager read an older one', async () => {
      const baseRead = { version: 2, sha: 'a'.repeat(64), readAt: READ_AT };
      await openProfile({ api: fakeApi({ getManagerProfile: vi.fn().mockResolvedValue(profileOf({ baseVersion: 3, baseRead })) }) });
      await screen.findByRole('region', { name: 'Profile' });

      expect(baseLineOf()).toHaveTextContent('Base v3, not read');
      expect(baseLineOf()).not.toHaveTextContent('read on');
    });

    it('user finds no control on the base line: it only informs', async () => {
      await openProfile({ api: fakeApi({ getManagerProfile: vi.fn().mockResolvedValue(profileOf({ baseVersion: 2 })) }) });
      await screen.findByRole('region', { name: 'Profile' });

      expect(within(baseLineOf()).queryByRole('button')).toBeNull();
      expect(within(baseLineOf()).queryByRole('link')).toBeNull();
    });

    it('user sees no base line from a daemon that does not report the base', async () => {
      await openProfile();
      await screen.findByRole('region', { name: 'Profile' });

      expect(screen.queryByText('Manager base')).toBeNull();
    });
  });

  describe('when more children are active than the cap allows', () => {
    it('user reads how many are active against the cap', async () => {
      const api = fakeApi({ getManagerProfile: vi.fn().mockResolvedValue(profileOf({ childrenCap: 2, childrenCount: 3 })) });

      await openProfile({ api });

      expect(await screen.findByText('3 active > cap 2')).toBeInTheDocument();
    });

    it.each([{ childrenCount: 2 }, { childrenCount: 1 }])('user reads no excess note with $childrenCount active children under a cap of 2', async ({ childrenCount }) => {
      const api = fakeApi({ getManagerProfile: vi.fn().mockResolvedValue(profileOf({ childrenCap: 2, childrenCount })) });

      await openProfile({ api });

      await screen.findByRole('region', { name: 'Profile' });
      expect(screen.queryByText(/active > cap/)).not.toBeInTheDocument();
    });
  });

  describe('where the mission stands against a Scape re-import', () => {
    it('user is told an edited mission will not be overwritten by a re-import', async () => {
      await openProfile({ api: fakeApi({ getManagerProfile: vi.fn().mockResolvedValue(profileOf({}, 'edited_in_openfleet')) }) });

      expect(await screen.findByText('Edited here — a Scape re-import will not overwrite it.')).toBeInTheDocument();
    });

    it('user is told an untouched imported mission can still be updated by a re-import', async () => {
      await openProfile({ api: fakeApi({ getManagerProfile: vi.fn().mockResolvedValue(profileOf({}, 'as_imported')) }) });

      expect(await screen.findByText('Imported from Scape and not edited here — a re-import can update it.')).toBeInTheDocument();
    });

    it('user sees no import line for a manager created in OpenFleet', async () => {
      await openProfile();

      await screen.findByRole('region', { name: 'Mission' });

      expect(screen.queryByText(/Scape/)).toBeNull();
    });
  });

  describe('editing the manager', () => {
    const openEditor = async (api = fakeApi()) => {
      await openProfile({ api });
      await screen.findByRole('button', { name: 'Save' });
      return api;
    };

    it('user finds the edit form already open, with Save off until something changes', async () => {
      await openEditor();

      expect(screen.getByRole('spinbutton', { name: 'Children cap' })).toHaveValue(4);
      expect(screen.getByRole('textbox', { name: 'Mission' })).toHaveValue(MISSION);
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      expect(screen.getByTestId('manager-changes-count')).toHaveTextContent('No changes');
    });

    it('user edits pulse cadence, children cap and model in one row, without the preset block', async () => {
      await openEditor();

      const row = screen.getByRole('group', { name: 'Pulse, children cap and model' });

      expect(within(row).getByRole('spinbutton', { name: 'Pulse cadence' })).toBeTruthy();
      expect(within(row).getByRole('spinbutton', { name: 'Children cap' })).toBeTruthy();
      expect(within(row).getByRole('combobox', { name: 'Model' })).toBeTruthy();
      expect(screen.queryByRole('group', { name: 'Pulse cadence presets' })).toBeNull();
    });

    it('user sees how many fields they changed', async () => {
      await openEditor();

      await userEvent.click(screen.getByRole('button', { name: 'Increase children cap' }));
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'opus');

      expect(screen.getByTestId('manager-changes-count')).toHaveTextContent('2 changed');
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    });

    it('user changes the children cap and saves it, and only that', async () => {
      const api = await openEditor();

      await userEvent.click(screen.getByRole('button', { name: 'Increase children cap' }));
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(api.updateManager).toHaveBeenCalledWith('m1', { childrenCap: 5 }));
    });

    it('user rewrites the mission, saves it and reads the new one', async () => {
      const api = fakeApi();
      api.getManagerProfile.mockResolvedValueOnce(profileOf()).mockResolvedValue(profileOf({ missionText: 'Ship the roadmap.' }, 'edited_in_openfleet'));
      await openEditor(api);

      const missionField = screen.getByRole('textbox', { name: 'Mission' });
      await userEvent.clear(missionField);
      await userEvent.type(missionField, 'Ship the roadmap.');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(api.updateManager).toHaveBeenCalledWith('m1', { mission: 'Ship the roadmap.' }));
      const mission = await screen.findByRole('region', { name: 'Mission' });
      expect(await within(mission).findByText('Ship the roadmap.')).toBeInTheDocument();
      expect(within(mission).getByText('Edited here — a Scape re-import will not overwrite it.')).toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId('manager-changes-count')).toHaveTextContent('No changes'));
    });

    it('user changes the model and saves it', async () => {
      const api = await openEditor();

      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'opus');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(api.updateManager).toHaveBeenCalledWith('m1', { model: 'opus' }));
    });

    it('user is told plainly that a live manager reads an edited mission at its next fresh start only', async () => {
      await openEditor();

      expect(screen.getByText(/A running manager does not re-read its mission when you save it/)).toHaveTextContent('only at its next fresh start');
    });

    it('user cannot save an empty mission and is told why', async () => {
      const api = await openEditor();

      await userEvent.clear(screen.getByRole('textbox', { name: 'Mission' }));
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByText('A manager needs a mission')).toBeInTheDocument();
      expect(api.updateManager).not.toHaveBeenCalled();
    });

    describe('a legacy mission of 30 KB', () => {
      const LEGACY_BYTES = 30_000;
      const legacyApi = () => fakeApi({ getManagerProfile: vi.fn().mockResolvedValue(profileOf({ missionText: 'l'.repeat(LEGACY_BYTES), legacyMission: true })) });
      const replaceMission = async (text: string) => {
        const missionField = screen.getByRole('textbox', { name: 'Mission' });
        await userEvent.clear(missionField);
        await userEvent.click(missionField);
        await userEvent.paste(text);
      };

      it('user is told to reduce it to the delta, and sees its size', async () => {
        await openEditor(legacyApi());

        expect(screen.getByTestId('manager-mission-legacy')).toHaveTextContent('Legacy mission: reduce it to the delta');
        expect(screen.getByTestId('manager-mission-size')).toHaveTextContent('29.3 / 8 KB');
        expect(screen.queryByTestId('manager-mission-error')).toBeNull();
      });

      it('user can save a shorter legacy mission of 20 KB, while the banner stays', async () => {
        const api = await openEditor(legacyApi());

        await replaceMission('l'.repeat(20_000));
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(api.updateManager).toHaveBeenCalledWith('m1', { mission: 'l'.repeat(20_000) }));
        expect(screen.getByTestId('manager-mission-legacy')).toBeInTheDocument();
      });

      it('user cannot make it grow to 31 KB: a blocking error shows and no call is sent', async () => {
        const api = await openEditor(legacyApi());

        await replaceMission('l'.repeat(31_000));
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(screen.getByTestId('manager-mission-error')).toHaveTextContent('can only shrink');
        expect(api.updateManager).not.toHaveBeenCalled();
      });

      it('user sees the banner go away once the mission is back at 8192 bytes', async () => {
        await openEditor(legacyApi());

        await replaceMission('l'.repeat(8192));

        expect(screen.queryByTestId('manager-mission-legacy')).toBeNull();
        expect(screen.queryByTestId('manager-mission-error')).toBeNull();
      });

      it('user can save another field without touching the legacy mission', async () => {
        const api = await openEditor(legacyApi());

        await userEvent.click(screen.getByRole('button', { name: 'Increase children cap' }));
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(api.updateManager).toHaveBeenCalledWith('m1', { childrenCap: 5 }));
      });
    });

    it('user sees the daemon refusal when the save fails, keeps the form, and saves again', async () => {
      const updateManager = vi.fn().mockRejectedValueOnce(apiFailure('invalid_body', 400)).mockResolvedValue(managerViewOf({ childrenCap: 5 }));
      const getManagerProfile = vi.fn().mockResolvedValueOnce(profileOf()).mockResolvedValue(profileOf({ childrenCap: 5 }));
      const api = await openEditor(fakeApi({ updateManager, getManagerProfile }));

      await userEvent.click(screen.getByRole('button', { name: 'Increase children cap' }));
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('The daemon rejected these values');
      expect(screen.getByRole('spinbutton', { name: 'Children cap' })).toHaveValue(5);
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(api.updateManager).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByTestId('manager-changes-count')).toHaveTextContent('No changes'));
    });
  });

  describe('reopening a closed manager', () => {
    it('user is told what Reopen and Resume each do', async () => {
      await openProfile();

      expect(await screen.findByTestId('manager-dashboard-reopen-explanation')).toHaveTextContent('Reopen starts a fresh conversation seeded with the mission; Resume continues the previous one.');
    });

    it('user reopens it fresh, from its mission', async () => {
      const api = await openProfile();

      await userEvent.click(await screen.findByRole('button', { name: 'Reopen' }));

      await waitFor(() => expect(api.reopenSession).toHaveBeenCalledWith('m1', 'fresh'));
    });

    it('user resumes its previous conversation', async () => {
      const api = await openProfile();

      await userEvent.click(await screen.findByRole('button', { name: 'Resume' }));

      await waitFor(() => expect(api.reopenSession).toHaveBeenCalledWith('m1', 'resume'));
    });

    it('user is told why a fresh reopen is refused when the mission is empty', async () => {
      const reopenSession = vi.fn().mockRejectedValue(apiFailure('mission_missing'));
      await openProfile({ api: fakeApi({ reopenSession }) });

      await userEvent.click(await screen.findByRole('button', { name: 'Reopen' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('This manager has no mission to start from');
    });

    it('user cannot reopen or resume a manager that is already running, and is told why', async () => {
      await openProfile({ session: sessionOf({ state: 'idle' }) });

      expect(await screen.findByRole('button', { name: 'Reopen' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
      expect(screen.getByText('This manager is running — close it to reopen or resume it.')).toBeInTheDocument();
    });

    it('user cannot trigger the reopen twice while it is in progress', async () => {
      const reopenSession = vi.fn().mockReturnValue(new Promise(() => undefined));
      await openProfile({ api: fakeApi({ reopenSession }) });

      await userEvent.click(await screen.findByRole('button', { name: 'Reopen' }));

      expect(screen.getByRole('button', { name: 'Reopen' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
    });
  });
});
