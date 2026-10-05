import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen, waitFor, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import type { Page, Project } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';
import { ProjectHomeComponent } from './project-home.component';

const FLEET: Project = { id: 'p-fleet', name: 'Fleet', docsFolderPath: '/work/fleet-docs' };
const ARMADA: Project = { id: 'p-armada', name: 'Armada', docsFolderPath: null };
const LAST_VISITED_KEY = 'openfleet.project-home.last-visited';

const pageOf = <T>(items: T[]): Page<T> => ({ items, total: items.length, limit: 200, offset: 0 });

interface ApiOverrides {
  projects?: Project[];
  listProjects?: () => Promise<Page<Project>>;
  noteTotals?: Record<string, number>;
  listNotes?: (projectId: string) => Promise<Page<unknown>>;
  listDataStores?: (projectId: string) => Promise<Page<unknown>>;
  listHandoffs?: (projectId: string) => Promise<Page<unknown>>;
}

function fakeApi(overrides: ApiOverrides = {}) {
  const projects = overrides.projects ?? [FLEET, ARMADA];
  return {
    listProjects: vi.fn(overrides.listProjects ?? (() => Promise.resolve(pageOf(projects)))),
    listNotes: vi.fn(overrides.listNotes ?? ((projectId: string) => Promise.resolve({ items: [], total: overrides.noteTotals?.[projectId] ?? 12, limit: 1, offset: 0 }))),
    listDataStores: vi.fn(overrides.listDataStores ?? (() => Promise.resolve(pageOf([{}, {}, {}])))),
    listHandoffs: vi.fn(overrides.listHandoffs ?? (() => Promise.resolve({ items: [], total: 5, limit: 200, offset: 0 }))),
    updateProject: vi.fn(),
    createProject: vi.fn(),
  };
}

const manager = (overrides: Record<string, unknown> = {}) => ({ id: 'm1', name: 'Capitaine', emoji: '🧭', role: 'manager', state: 'idle', projectId: FLEET.id, ...overrides });
const worker = (overrides: Record<string, unknown> = {}) => ({ id: 's1', name: 'Gimli', emoji: '⛏️', state: 'generating', projectId: FLEET.id, parentId: 'm1', ...overrides });

@Component({ template: 'elsewhere' })
class ElsewhereStub {}

async function openAt(url: string, { api = fakeApi(), sessions = [] as unknown[] } = {}) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'project', component: ProjectHomeComponent },
        { path: 'project/:id', component: ProjectHomeComponent },
        { path: '**', component: ElsewhereStub },
      ]),
      { provide: FleetApiService, useValue: api },
      { provide: FleetEventsService, useValue: { sessions: signal(sessions), managers: signal([]) } },
    ],
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  return { api, harness, router: TestBed.inject(Router) };
}

const switcher = () => screen.getByRole<HTMLSelectElement>('combobox', { name: 'Project' });
const countOf = (label: string) => within(screen.getByRole('region', { name: 'Overview' })).getByText(label).closest('div')!;

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value) });
});

afterEach(() => vi.unstubAllGlobals());

describe('the project home page', () => {
  describe('loading the projects', () => {
    it('user sees a loading message until the projects arrive', async () => {
      const never = () => new Promise<Page<Project>>(() => undefined);

      await openAt('/project', { api: fakeApi({ listProjects: never }) });

      expect(screen.getByRole('status')).toHaveTextContent('Loading projects…');
    });

    it('user is told the projects could not load and retries from the page', async () => {
      const listProjects = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(pageOf([FLEET]));
      await openAt('/project/p-fleet', { api: fakeApi({ listProjects }) });

      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load your projects.");
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

      expect(await screen.findByRole('heading', { level: 1, name: 'Fleet' })).toBeInTheDocument();
    });
  });

  describe('when there is no project', () => {
    it('user sees an empty state that offers to create a project', async () => {
      await openAt('/project', { api: fakeApi({ projects: [] }) });

      expect(await screen.findByRole('heading', { level: 1, name: 'No projects yet' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create a project' })).toBeInTheDocument();
    });

    it('user creates the first project and lands on its home', async () => {
      const api = fakeApi({ projects: [] });
      api.createProject.mockImplementation(() => {
        api.listProjects.mockResolvedValue(pageOf([FLEET]));
        return Promise.resolve(FLEET);
      });
      const { router }= await openAt('/project', { api });
      await userEvent.click(await screen.findByRole('button', { name: 'Create a project' }));

      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Fleet');
      await userEvent.click(screen.getByTestId('project-save'));

      await waitFor(() => expect(router.url).toBe('/project/p-fleet'));
      expect(await screen.findByRole('heading', { level: 1, name: 'Fleet' })).toBeInTheDocument();
    });
  });

  describe('choosing the project from /project', () => {
    it('lands on the first project when none was visited', async () => {
      const { router } = await openAt('/project');

      await waitFor(() => expect(router.url).toBe('/project/p-fleet'));
    });

    it('lands on the project the user visited last', async () => {
      localStorage.setItem(LAST_VISITED_KEY, ARMADA.id);

      const { router } = await openAt('/project');

      await waitFor(() => expect(router.url).toBe('/project/p-armada'));
    });

    it('ignores a last visited project that no longer exists', async () => {
      localStorage.setItem(LAST_VISITED_KEY, 'gone');

      const { router } = await openAt('/project');

      await waitFor(() => expect(router.url).toBe('/project/p-fleet'));
    });

    it('remembers the project the user opened', async () => {
      await openAt('/project/p-armada');
      await screen.findByRole('heading', { level: 1, name: 'Armada' });

      expect(localStorage.getItem(LAST_VISITED_KEY)).toBe('p-armada');
    });
  });

  describe('the header and the project switcher', () => {
    it('user sees the project name as the page heading', async () => {
      await openAt('/project/p-fleet');

      expect(await screen.findByRole('heading', { level: 1, name: 'Fleet' })).toBeInTheDocument();
    });

    it('user is told when the project of the address does not exist', async () => {
      await openAt('/project/ghost');

      expect(await screen.findByRole('alert')).toHaveTextContent('This project no longer exists.');
    });

    it('user sees no switcher when there is a single project', async () => {
      await openAt('/project/p-fleet', { api: fakeApi({ projects: [FLEET] }) });
      await screen.findByRole('heading', { level: 1, name: 'Fleet' });

      expect(screen.queryByRole('combobox', { name: 'Project' })).toBeNull();
    });

    it('user switches project and sees the other project page', async () => {
      const { router } = await openAt('/project/p-fleet');
      await screen.findByRole('heading', { level: 1, name: 'Fleet' });
      expect(switcher().value).toBe('p-fleet');

      await userEvent.selectOptions(switcher(), 'Armada');

      await waitFor(() => expect(router.url).toBe('/project/p-armada'));
      expect(await screen.findByRole('heading', { level: 1, name: 'Armada' })).toBeInTheDocument();
      expect(switcher().value).toBe('p-armada');
    });

    it('user sees the counts of the project switched to, not of the previous one', async () => {
      const api = fakeApi({ noteTotals: { 'p-fleet': 12, 'p-armada': 3 } });
      await openAt('/project/p-fleet', { api });
      await waitFor(() => expect(countOf('Notes')).toHaveTextContent('12'));

      await userEvent.selectOptions(switcher(), 'Armada');

      await waitFor(() => expect(countOf('Notes')).toHaveTextContent('3'));
    });
  });

  describe('the docs folder card', () => {
    it('user sees the docs folder path', async () => {
      await openAt('/project/p-fleet');

      const card = await screen.findByRole('region', { name: 'Docs folder' });

      expect(within(card).getByText('/work/fleet-docs')).toBeInTheDocument();
    });

    it('user sees that a project has no docs folder', async () => {
      await openAt('/project/p-armada');

      const card = await screen.findByRole('region', { name: 'Docs folder' });

      expect(within(card).getByText('No docs folder')).toBeInTheDocument();
    });

    it('user changes the docs folder and sees the new path', async () => {
      const api = fakeApi();
      api.updateProject.mockResolvedValue({ ...FLEET, docsFolderPath: '/work/elsewhere' });
      await openAt('/project/p-fleet', { api });
      await userEvent.click(await screen.findByRole('button', { name: 'Change…' }));

      const field = screen.getByRole('textbox', { name: 'Docs folder' });
      await userEvent.clear(field);
      await userEvent.type(field, '/work/elsewhere');
      await userEvent.click(screen.getByTestId('project-save'));

      const card = screen.getByRole('region', { name: 'Docs folder' });
      expect(await within(card).findByText('/work/elsewhere')).toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Edit docs folder' })).toBeNull();
      expect(api.updateProject).toHaveBeenCalledExactlyOnceWith('p-fleet', { docsFolderPath: '/work/elsewhere' });
    });

    it('user cancels the edit, keeps the path and gets the focus back on Change…', async () => {
      await openAt('/project/p-fleet');
      await userEvent.click(await screen.findByRole('button', { name: 'Change…' }));

      await userEvent.click(screen.getByTestId('project-cancel'));

      expect(screen.queryByRole('group', { name: 'Edit docs folder' })).toBeNull();
      expect(screen.getByText('/work/fleet-docs')).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Change…' })).toHaveFocus());
    });
  });

  describe('the counts', () => {
    it('user sees how many notes, tables and handoffs the project has', async () => {
      await openAt('/project/p-fleet');

      await waitFor(() => expect(countOf('Notes')).toHaveTextContent('12'));
      expect(countOf('Tables')).toHaveTextContent('3');
      expect(countOf('Handoffs')).toHaveTextContent('5');
    });

    it('user sees 0, never a blank, for a project without notes, tables or handoffs', async () => {
      const api = fakeApi({
        listNotes: () => Promise.resolve({ items: [], total: 0, limit: 1, offset: 0 }),
        listDataStores: () => Promise.resolve(pageOf([])),
        listHandoffs: () => Promise.resolve({ items: [], total: 0, limit: 200, offset: 0 }),
      });
      await openAt('/project/p-fleet', { api });

      await waitFor(() => expect(countOf('Notes')).toHaveTextContent('0'));
      expect(countOf('Tables')).toHaveTextContent('0');
      expect(countOf('Handoffs')).toHaveTextContent('0');
    });

    it('user still sees the other counts and the rest of the page when one count fails', async () => {
      const api = fakeApi({ listDataStores: () => Promise.reject(new Error('boom')) });
      await openAt('/project/p-fleet', { api });

      await waitFor(() => expect(countOf('Tables')).toHaveTextContent("Couldn't load"));
      expect(countOf('Notes')).toHaveTextContent('12');
      expect(countOf('Handoffs')).toHaveTextContent('5');
      expect(screen.getByRole('heading', { level: 1, name: 'Fleet' })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Docs folder' })).toBeInTheDocument();
    });
  });

  describe('the managers and sessions of the project', () => {
    it('user sees the managers and the sessions of this project only, each linking to its screen', async () => {
      const sessions = [manager(), worker(), manager({ id: 'm2', name: 'Other manager', projectId: ARMADA.id }), worker({ id: 's2', name: 'Elsewhere', projectId: ARMADA.id }), worker({ id: 's3', name: 'Loose', projectId: undefined })];
      await openAt('/project/p-fleet', { sessions });

      const managers = await screen.findByRole('region', { name: 'Managers' });
      const sessionsRegion = screen.getByRole('region', { name: 'Sessions' });

      expect(within(managers).getByRole('link', { name: /Capitaine/ })).toHaveAttribute('href', '/manager/m1');
      expect(within(sessionsRegion).getByRole('link', { name: /Gimli/ })).toHaveAttribute('href', '/session/s1');
      expect(screen.queryByText(/Other manager/)).toBeNull();
      expect(screen.queryByText(/Elsewhere/)).toBeNull();
      expect(screen.queryByText(/Loose/)).toBeNull();
    });

    it('user sees the state of each session, a closed one included', async () => {
      await openAt('/project/p-fleet', { sessions: [manager({ state: 'closed' }), worker()] });

      const managers = await screen.findByRole('region', { name: 'Managers' });
      const sessionsRegion = screen.getByRole('region', { name: 'Sessions' });

      expect(within(managers).getByTestId('state-chip')).toHaveAttribute('data-state', 'closed');
      expect(within(sessionsRegion).getByTestId('state-chip')).toHaveAttribute('data-state', 'generating');
    });

    it('user is told there is no manager and no session yet', async () => {
      await openAt('/project/p-fleet');

      expect(await within(await screen.findByRole('region', { name: 'Managers' })).findByText('No managers in this project yet')).toBeInTheDocument();
      expect(within(screen.getByRole('region', { name: 'Sessions' })).getByText('No sessions in this project yet')).toBeInTheDocument();
    });
  });

  describe('the quick actions', () => {
    it('user starts a session, opens the notes or the tables of this project', async () => {
      await openAt('/project/p-fleet');
      const actions = await screen.findByRole('navigation', { name: 'Quick actions' });

      expect(within(actions).getByRole('link', { name: 'New session in this project' })).toHaveAttribute('href', '/new?projectId=p-fleet');
      expect(within(actions).getByRole('link', { name: 'Notes' })).toHaveAttribute('href', '/notes?projectId=p-fleet');
      expect(within(actions).getByRole('link', { name: 'Tables' })).toHaveAttribute('href', '/tables?projectId=p-fleet');
    });
  });
});
