import { render, screen, waitFor, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import type { Page, Project } from '@openfleet/shared';
import { BehaviorSubject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { NewSessionFormComponent } from './new-session-form.component';

const FLEET: Project = { id: '3f2b8c1e-5d4a-4b6e-9a7c-1d2e3f4a5b6c', name: 'Fleet', docsFolderPath: '/work/fleet-docs' };
const ARMADA: Project = { id: '9a1d7e52-0c3b-4f48-8d6a-2b5c7e9f1a30', name: 'Armada', docsFolderPath: null };

const pageOf = (items: Project[]): Page<Project> => ({ items, total: items.length, limit: 200, offset: 0 });

function fakeApi(listProjects: () => Promise<Page<Project>> = () => Promise.resolve(pageOf([FLEET, ARMADA]))) {
  return {
    listProjects: vi.fn(listProjects),
    createSession: vi.fn().mockResolvedValue({ id: 's-new' }),
    createManagerSession: vi.fn().mockResolvedValue({ id: 'm-new' }),
    createProject: vi.fn(),
  };
}

async function renderForm(api: ReturnType<typeof fakeApi>, queryParams: Record<string, string> = {}) {
  const { fixture } = await render(NewSessionFormComponent, {
    providers: [
      provideRouter([]),
      { provide: FleetApiService, useValue: api },
      { provide: ActivatedRoute, useValue: { queryParamMap: new BehaviorSubject(convertToParamMap(queryParams)) } },
    ],
  });
  vi.spyOn(fixture.debugElement.injector.get(Router), 'navigate').mockResolvedValue(true);
  return fixture;
}

const projectSelect = () => screen.getByRole<HTMLSelectElement>('combobox', { name: 'Project' });
const projectSelectIfShown = () => screen.queryByRole('combobox', { name: 'Project' });
const projectNote = () => screen.queryByTestId('new-session-project-note');
const submitButton = () => screen.getByTestId('new-session-submit');
const optionLabels = () => within(projectSelect()).getAllByRole('option').map((option) => option.textContent?.trim());
const waitForProjectsToLoad = () => waitFor(() => expect(projectSelect()).toBeInTheDocument());

async function fillSessionFields(): Promise<void> {
  await userEvent.type(screen.getByTestId('new-session-directory'), '/tmp/wt');
  await userEvent.type(screen.getByTestId('new-session-name'), 'Gimli');
}

describe('the Project field of the New session form', () => {
  it('offers "No project" first and selected, then the daemon projects in order', async () => {
    await renderForm(fakeApi());

    await waitForProjectsToLoad();

    expect(optionLabels()).toEqual(['No project', 'Fleet', 'Armada']);
    expect(projectSelect().value).toBe('');
  });

  it('asks the daemon for the projects once, however often the user switches kind of session', async () => {
    const api = fakeApi();
    await renderForm(api);
    await waitForProjectsToLoad();

    await userEvent.click(screen.getByTestId('new-session-mode-manager'));
    await userEvent.click(screen.getByTestId('new-session-mode-session'));

    expect(api.listProjects).toHaveBeenCalledTimes(1);
  });

  it('preselects the project named by the projectId query parameter and creates the session in it', async () => {
    const api = fakeApi();
    await renderForm(api, { projectId: ARMADA.id });
    await waitForProjectsToLoad();

    await fillSessionFields();
    await userEvent.click(submitButton());

    expect(projectSelect().value).toBe(ARMADA.id);
    expect(api.createSession.mock.calls[0]![0]).toMatchObject({ projectId: ARMADA.id });
  });

  it('creates a session without a project id when the user keeps "No project"', async () => {
    const api = fakeApi();
    await renderForm(api);
    await waitForProjectsToLoad();

    await fillSessionFields();
    await userEvent.click(submitButton());

    expect(api.createSession.mock.calls[0]![0]).toStrictEqual({ directory: '/tmp/wt', name: 'Gimli', emoji: '🤖', model: 'sonnet', harness: 'claude-cli' });
  });

  it('creates a session in the project the user chose', async () => {
    const api = fakeApi();
    await renderForm(api);
    await waitForProjectsToLoad();

    await userEvent.selectOptions(projectSelect(), 'Armada');
    await fillSessionFields();
    await userEvent.click(submitButton());

    expect(api.createSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ directory: '/tmp/wt', name: 'Gimli', projectId: ARMADA.id }));
  });

  it('creates a session without a project id after the user goes back to "No project"', async () => {
    const api = fakeApi();
    await renderForm(api);
    await waitForProjectsToLoad();

    await userEvent.selectOptions(projectSelect(), 'Fleet');
    await userEvent.selectOptions(projectSelect(), 'No project');
    await fillSessionFields();
    await userEvent.click(submitButton());

    expect(api.createSession.mock.calls[0]![0]).not.toHaveProperty('projectId');
  });

  it('keeps the chosen project when the user switches to a manager, and creates the manager in it', async () => {
    const api = fakeApi();
    await renderForm(api);
    await waitForProjectsToLoad();
    await userEvent.selectOptions(projectSelect(), 'Fleet');

    await userEvent.click(screen.getByTestId('new-session-mode-manager'));
    await fillSessionFields();
    await userEvent.type(screen.getByTestId('manager-mission'), 'Ship phase 3');
    await userEvent.click(submitButton());

    expect(projectSelect().value).toBe(FLEET.id);
    expect(api.createManagerSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'Gimli', mission: 'Ship phase 3', projectId: FLEET.id }));
    expect(api.createSession).not.toHaveBeenCalled();
  });

  it('shows the field on the New manager page too, from the first render of that page', async () => {
    await renderForm(fakeApi(), { mode: 'manager' });

    await waitForProjectsToLoad();

    expect(optionLabels()).toEqual(['No project', 'Fleet', 'Armada']);
  });

  it('locks the field while the session is being created', async () => {
    let settle!: (session: { id: string }) => void;
    const api = fakeApi();
    api.createSession.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    await renderForm(api);
    await waitForProjectsToLoad();
    await fillSessionFields();

    await userEvent.click(submitButton());

    expect(projectSelect()).toBeDisabled();
    settle({ id: 's-new' });
    await waitFor(() => expect(projectSelect()).toBeEnabled());
  });

  describe('when the user has no project yet', () => {
    const noProjectsApi = () => fakeApi(() => Promise.resolve(pageOf([])));
    const createProjectTrigger = () => screen.getByRole('button', { name: 'Create a project…' });
    const projectForm = () => within(screen.getByRole('group', { name: 'Create a project' }));
    const projectNameField = () => projectForm().getByRole<HTMLInputElement>('textbox', { name: 'Name' });
    const projectDocsFolderField = () => projectForm().getByRole<HTMLInputElement>('textbox', { name: 'Docs folder' });
    const submitProjectForm = () => userEvent.click(projectForm().getByRole('button', { name: 'Create project' }));

    it('shows no Project select but offers to create a project, and creates the session as before', async () => {
      const api = noProjectsApi();
      await renderForm(api);
      await waitFor(() => expect(createProjectTrigger()).toBeInTheDocument());

      await fillSessionFields();
      await userEvent.click(submitButton());

      expect(screen.getByText(/No projects yet/)).toBeInTheDocument();
      expect(projectSelectIfShown()).not.toBeInTheDocument();
      expect(projectNote()).not.toBeInTheDocument();
      expect(api.createSession.mock.calls[0]![0]).not.toHaveProperty('projectId');
    });

    it('does not claim there is no project while the projects are still loading', async () => {
      await renderForm(fakeApi(() => new Promise(() => undefined)));

      expect(screen.queryByText(/No projects yet/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Create a project…' })).not.toBeInTheDocument();
    });

    it('offers no project creation when the projects could not be loaded, since there may be some', async () => {
      await renderForm(fakeApi(() => Promise.reject(new Error('daemon unreachable'))));
      await waitFor(() => expect(projectNote()).toBeInTheDocument());

      expect(screen.queryByRole('button', { name: 'Create a project…' })).not.toBeInTheDocument();
    });

    it('opens the project form, with the cursor in its Name field, when "Create a project…" is pressed', async () => {
      await renderForm(noProjectsApi());
      await waitFor(() => expect(createProjectTrigger()).toBeInTheDocument());

      await userEvent.click(createProjectTrigger());

      expect(screen.getByRole('group', { name: 'Create a project' })).toBeInTheDocument();
      await waitFor(() => expect(projectNameField()).toHaveFocus());
      expect(createProjectTrigger()).toHaveAttribute('aria-expanded', 'true');
    });

    it('gives the cursor back to "Create a project…" when the user cancels', async () => {
      await renderForm(noProjectsApi());
      await waitFor(() => expect(createProjectTrigger()).toBeInTheDocument());
      await userEvent.click(createProjectTrigger());

      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('group', { name: 'Create a project' })).not.toBeInTheDocument();
      await waitFor(() => expect(createProjectTrigger()).toHaveFocus());
    });

    it('selects the new project in a Project select that replaces the link, announces it, and moves the cursor to the select', async () => {
      const api = noProjectsApi();
      const created: Project = { id: 'p-new', name: 'Fleet', docsFolderPath: '/work/fleet-docs' };
      const createProject = vi.fn().mockResolvedValue(created);
      await renderForm({ ...api, createProject } as ReturnType<typeof fakeApi>);
      await waitFor(() => expect(createProjectTrigger()).toBeInTheDocument());
      await userEvent.click(createProjectTrigger());

      await userEvent.type(projectNameField(), 'Fleet');
      await userEvent.type(projectDocsFolderField(), '/work/fleet-docs');
      await submitProjectForm();

      await waitFor(() => expect(projectSelect()).toBeInTheDocument());
      expect(createProject).toHaveBeenCalledExactlyOnceWith({ name: 'Fleet', docsFolderPath: '/work/fleet-docs' });
      expect(optionLabels()).toEqual(['No project', 'Fleet']);
      expect(projectSelect().value).toBe('p-new');
      expect(screen.getByRole('status')).toHaveTextContent('Project created');
      expect(screen.queryByRole('group', { name: 'Create a project' })).not.toBeInTheDocument();
      expect(screen.queryByText(/No projects yet/)).not.toBeInTheDocument();
      await waitFor(() => expect(projectSelect()).toHaveFocus());
    });

    it('creates the session in the project the user just created', async () => {
      const api = noProjectsApi();
      const created: Project = { id: 'p-new', name: 'Fleet', docsFolderPath: null };
      await renderForm({ ...api, createProject: vi.fn().mockResolvedValue(created) } as ReturnType<typeof fakeApi>);
      await waitFor(() => expect(createProjectTrigger()).toBeInTheDocument());
      await userEvent.click(createProjectTrigger());
      await userEvent.type(projectNameField(), 'Fleet');
      await submitProjectForm();
      await waitFor(() => expect(projectSelect()).toBeInTheDocument());

      await fillSessionFields();
      await userEvent.click(submitButton());

      expect(api.createSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ projectId: 'p-new' }));
    });

    it('keeps the project form open with the daemon refusal, and creates no session, when Enter is pressed in its fields', async () => {
      const api = noProjectsApi();
      const createProject = vi.fn().mockRejectedValue(new ApiError(400, 'POST /api/projects', 'invalid_body'));
      await renderForm({ ...api, createProject } as ReturnType<typeof fakeApi>);
      await waitFor(() => expect(createProjectTrigger()).toBeInTheDocument());
      await userEvent.click(createProjectTrigger());
      await userEvent.type(projectNameField(), 'Fleet');

      await userEvent.type(projectDocsFolderField(), 'relative{Enter}');

      expect(await screen.findByText('That folder cannot be used: use an existing absolute folder path.')).toBeInTheDocument();
      expect(createProject).toHaveBeenCalledOnce();
      expect(api.createSession).not.toHaveBeenCalled();
      expect(screen.getByRole('group', { name: 'Create a project' })).toBeInTheDocument();
    });

    it('closes only the project form when Escape is pressed in it', async () => {
      const api = noProjectsApi();
      await renderForm(api);
      await waitFor(() => expect(createProjectTrigger()).toBeInTheDocument());
      await userEvent.click(createProjectTrigger());

      await userEvent.keyboard('{Escape}');

      expect(screen.queryByRole('group', { name: 'Create a project' })).not.toBeInTheDocument();
      expect(screen.getByTestId('new-session-form')).toBeInTheDocument();
    });
  });

  describe('when the projects cannot be loaded', () => {
    const failingApi = () => fakeApi(() => Promise.reject(new Error('daemon unreachable')));

    it('tells the user politely, without an alert, and shows no Project field', async () => {
      await renderForm(failingApi());

      await waitFor(() => expect(projectNote()).toBeInTheDocument());

      expect(projectNote()).toHaveTextContent("Couldn't load your projects. You can still create a session without one.");
      expect(projectNote()).toHaveAttribute('role', 'status');
      expect(projectSelectIfShown()).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('reads an answer that is not a page of projects as a failed load', async () => {
      await renderForm(fakeApi(() => Promise.resolve({ id: 's-new' } as unknown as Page<Project>)));

      await waitFor(() => expect(projectNote()).toBeInTheDocument());

      expect(projectSelectIfShown()).not.toBeInTheDocument();
    });

    it('still creates the session, without a project id', async () => {
      const api = failingApi();
      await renderForm(api);
      await waitFor(() => expect(projectNote()).toBeInTheDocument());

      await fillSessionFields();
      await userEvent.click(submitButton());

      expect(api.createSession).toHaveBeenCalledOnce();
      expect(api.createSession.mock.calls[0]![0]).not.toHaveProperty('projectId');
    });
  });
});
