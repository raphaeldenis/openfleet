import { render, screen, waitFor, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import type { Page, Project } from '@openfleet/shared';
import { BehaviorSubject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import { NewSessionFormComponent } from './new-session-form.component';

const FLEET: Project = { id: '3f2b8c1e-5d4a-4b6e-9a7c-1d2e3f4a5b6c', name: 'Fleet', docsFolderPath: '/work/fleet-docs' };
const ARMADA: Project = { id: '9a1d7e52-0c3b-4f48-8d6a-2b5c7e9f1a30', name: 'Armada', docsFolderPath: null };

const pageOf = (items: Project[]): Page<Project> => ({ items, total: items.length, limit: 200, offset: 0 });

function fakeApi(listProjects: () => Promise<Page<Project>> = () => Promise.resolve(pageOf([FLEET, ARMADA]))) {
  return {
    listProjects: vi.fn(listProjects),
    createSession: vi.fn().mockResolvedValue({ id: 's-new' }),
    createManagerSession: vi.fn().mockResolvedValue({ id: 'm-new' }),
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
    it('shows no Project field and no note, and creates the session as before', async () => {
      const api = fakeApi(() => Promise.resolve(pageOf([])));
      await renderForm(api);
      await waitFor(() => expect(api.listProjects).toHaveBeenCalled());

      await fillSessionFields();
      await userEvent.click(submitButton());

      expect(projectSelectIfShown()).not.toBeInTheDocument();
      expect(projectNote()).not.toBeInTheDocument();
      expect(api.createSession.mock.calls[0]![0]).not.toHaveProperty('projectId');
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
