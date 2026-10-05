import { signal } from '@angular/core';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { render, screen, waitFor, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import type { ManagerProfile, ManagerView, Page, Project, ScapeImportStatus } from '@openfleet/shared';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { ManagerDashboardComponent } from './manager-dashboard.component';

const FLEET: Project = { id: 'p-fleet', name: 'Fleet', docsFolderPath: null };
const TEN_MINUTES_AGO = new Date(Date.now() - 10 * 60_000).toISOString();

const MISSION = '# Run the fleet\n\nKeep the backlog moving.\n\n- Spawn at most 4 children\n- Log every decision';

const sessionOf = (overrides: Record<string, unknown> = {}) => ({
  id: 'm1', name: 'Capitaine', emoji: '🧭', role: 'manager', state: 'closed', harness: 'claude-cli', model: 'sonnet', projectId: FLEET.id, stateSince: TEN_MINUTES_AGO, ...overrides,
});

const managerViewOf = (overrides: Partial<ManagerView> = {}): ManagerView => ({
  sessionId: 'm1', pulseSeconds: 600, childrenCap: 4, missionText: MISSION, nextPulseAt: new Date(Date.now() + 60_000).toISOString(), childrenCount: 0, ...overrides,
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
    getManagerProfile: overrides.getManagerProfile ?? vi.fn().mockResolvedValue(profileOf()),
    updateManager: overrides.updateManager ?? vi.fn().mockResolvedValue(managerViewOf()),
    reopenSession: overrides.reopenSession ?? vi.fn().mockResolvedValue({}),
    listProjects: overrides.listProjects ?? vi.fn().mockResolvedValue(pageOf([FLEET])),
    pulseNow: vi.fn().mockResolvedValue({ pulsed: true }),
    models: vi.fn().mockResolvedValue({}),
  };
}

async function openProfile({ api = fakeApi(), session = sessionOf() } = {}) {
  const events = {
    sessions: signal([session]), approvals: signal([]), managers: signal([managerViewOf()]), snapshotReceived: signal(true),
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
    it('user sees a loading message until the profile arrives', async () => {
      const never = vi.fn().mockReturnValue(new Promise(() => undefined));

      await openProfile({ api: fakeApi({ getManagerProfile: never }) });

      expect(screen.getByText('Loading the manager profile…')).toHaveAttribute('role', 'status');
    });

    it('user is told the profile could not load and retries from the page', async () => {
      const getManagerProfile = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(profileOf());
      await openProfile({ api: fakeApi({ getManagerProfile }) });

      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load this manager's profile.");
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

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
