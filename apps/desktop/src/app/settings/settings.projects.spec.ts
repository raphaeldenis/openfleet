import { render, screen, waitFor, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import type { Page, Project } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { SettingsComponent } from './settings.component';

const FLEET: Project = { id: '3f2b8c1e-5d4a-4b6e-9a7c-1d2e3f4a5b6c', name: 'Fleet', docsFolderPath: '/work/fleet-docs' };
const ARMADA: Project = { id: '9a1d7e52-0c3b-4f48-8d6a-2b5c7e9f1a30', name: 'Armada', docsFolderPath: null };
const LONG_PATH = `/Users/someone/Documents/${'very-long-folder-name/'.repeat(8)}docs`;

const pageOf = (items: Project[]): Page<Project> => ({ items, total: items.length, limit: 200, offset: 0 });

function fakeApi(initialProjects: Project[]) {
  const projects = [...initialProjects];
  return {
    projects,
    models: vi.fn(() => Promise.resolve({})),
    availableModels: vi.fn(() => Promise.resolve({ models: [] })),
    listProjects: vi.fn(() => Promise.resolve(pageOf([...projects]))),
    createProject: vi.fn((request: { name: string; docsFolderPath?: string }) => {
      const created: Project = { id: 'new-project', name: request.name, docsFolderPath: request.docsFolderPath ?? null };
      projects.push(created);
      return Promise.resolve(created);
    }),
    updateProject: vi.fn((id: string, patch: { name?: string; docsFolderPath?: string }) => {
      const index = projects.findIndex((project) => project.id === id);
      projects[index] = { ...projects[index]!, ...patch };
      return Promise.resolve(projects[index]!);
    }),
  };
}

async function renderSettings(api: ReturnType<typeof fakeApi>) {
  return render(SettingsComponent, { providers: [{ provide: FleetApiService, useValue: api }] });
}

const projectsSection = () => screen.getByTestId('settings-projects');
const createTrigger = () => screen.getByRole('button', { name: 'Create a project…' });
const rowOf = (name: string) => within(projectsSection()).getByText(name).closest('of-settings-row') as HTMLElement;
const editTriggerOf = (name: string) => screen.getByRole('button', { name: `Edit docs folder of ${name}` });
const nameField = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' });
const docsFolderField = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Docs folder' });

describe('Settings → General → Projects', () => {
  describe('the list', () => {
    it('shows each project with its docs folder, or says it has none', async () => {
      await renderSettings(fakeApi([FLEET, ARMADA]));

      await waitFor(() => expect(rowOf('Fleet')).toBeInTheDocument());

      expect(within(rowOf('Fleet')).getByText('/work/fleet-docs')).toBeInTheDocument();
      expect(within(rowOf('Armada')).getByText('No docs folder')).toBeInTheDocument();
    });

    it('shows a very long docs folder path in full, so that the user can read it', async () => {
      await renderSettings(fakeApi([{ ...FLEET, docsFolderPath: LONG_PATH }]));

      expect(await screen.findByText(LONG_PATH)).toBeInTheDocument();
    });

    it('says there is no project yet, and still offers to create one', async () => {
      await renderSettings(fakeApi([]));

      expect(await screen.findByText('No projects yet')).toBeInTheDocument();
      expect(createTrigger()).toBeEnabled();
    });

    it('tells the user politely, without an alert, when the projects cannot be loaded', async () => {
      const api = fakeApi([]);
      api.listProjects.mockRejectedValue(new TypeError('Failed to fetch'));
      await renderSettings(api);

      const note = await screen.findByText("Couldn't load your projects.");

      expect(note).toHaveAttribute('role', 'status');
      expect(screen.queryByText('No projects yet')).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(createTrigger()).toBeEnabled();
    });
  });

  describe('creating a project', () => {
    it('opens the form, with the cursor in the Name field, when "Create a project…" is pressed', async () => {
      await renderSettings(fakeApi([]));
      await screen.findByText('No projects yet');

      await userEvent.click(createTrigger());

      expect(screen.getByRole('group', { name: 'Create a project' })).toBeInTheDocument();
      await waitFor(() => expect(nameField()).toHaveFocus());
      expect(createTrigger()).toHaveAttribute('aria-expanded', 'true');
    });

    it('lists the new project, announces it, closes the form and gives the cursor back to the trigger', async () => {
      const api = fakeApi([FLEET]);
      await renderSettings(api);
      await screen.findByText('Fleet');
      await userEvent.click(createTrigger());

      await userEvent.type(nameField(), 'Armada');
      await userEvent.type(docsFolderField(), '/work/armada-docs');
      await userEvent.click(screen.getByRole('button', { name: 'Create project' }));

      expect(await screen.findByText('/work/armada-docs')).toBeInTheDocument();
      expect(api.listProjects).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('status')).toHaveTextContent('Project created');
      expect(screen.queryByRole('group', { name: 'Create a project' })).not.toBeInTheDocument();
      await waitFor(() => expect(createTrigger()).toHaveFocus());
      expect(createTrigger()).toHaveAttribute('aria-expanded', 'false');
    });

    it('keeps the form and explains the refusal when the daemon refuses the folder', async () => {
      const api = fakeApi([]);
      api.createProject.mockRejectedValue(new ApiError(400, 'POST /api/projects', 'invalid_body'));
      await renderSettings(api);
      await screen.findByText('No projects yet');
      await userEvent.click(createTrigger());

      await userEvent.type(nameField(), 'Fleet');
      await userEvent.type(docsFolderField(), 'relative');
      await userEvent.click(screen.getByRole('button', { name: 'Create project' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('That folder cannot be used: use an existing absolute folder path.');
      expect(screen.getByRole('group', { name: 'Create a project' })).toBeInTheDocument();
      expect(screen.getByRole('status').textContent).toBe('');
    });

    it('closes the form and gives the cursor back to the trigger when the user cancels', async () => {
      await renderSettings(fakeApi([]));
      await screen.findByText('No projects yet');
      await userEvent.click(createTrigger());

      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('group', { name: 'Create a project' })).not.toBeInTheDocument();
      await waitFor(() => expect(createTrigger()).toHaveFocus());
    });

    it('closes the form from Escape and gives the cursor back to the trigger', async () => {
      await renderSettings(fakeApi([]));
      await screen.findByText('No projects yet');
      await userEvent.click(createTrigger());

      await userEvent.keyboard('{Escape}');

      expect(screen.queryByRole('group', { name: 'Create a project' })).not.toBeInTheDocument();
      await waitFor(() => expect(createTrigger()).toHaveFocus());
    });
  });

  describe('editing the docs folder of a project', () => {
    it('opens the form on that project, with the cursor in the Docs folder field', async () => {
      await renderSettings(fakeApi([FLEET, ARMADA]));
      await screen.findByText('Armada');

      await userEvent.click(editTriggerOf('Armada'));

      expect(screen.getByRole('group', { name: 'Edit docs folder' })).toBeInTheDocument();
      expect(nameField()).toHaveValue('Armada');
      await waitFor(() => expect(docsFolderField()).toHaveFocus());
    });

    it('updates the project, refreshes the list, announces it and gives the cursor back to that project\'s button', async () => {
      const api = fakeApi([FLEET, ARMADA]);
      await renderSettings(api);
      await screen.findByText('Armada');
      await userEvent.click(editTriggerOf('Armada'));

      await userEvent.type(docsFolderField(), '/work/armada-docs');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByText('/work/armada-docs')).toBeInTheDocument();
      expect(api.updateProject).toHaveBeenCalledExactlyOnceWith(ARMADA.id, { docsFolderPath: '/work/armada-docs' });
      expect(screen.getByRole('status')).toHaveTextContent('Project updated');
      await waitFor(() => expect(editTriggerOf('Armada')).toHaveFocus());
    });

    it('gives the cursor back to the button of that project when the user cancels', async () => {
      await renderSettings(fakeApi([FLEET, ARMADA]));
      await screen.findByText('Armada');
      await userEvent.click(editTriggerOf('Armada'));

      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(editTriggerOf('Armada')).toHaveFocus());
    });

    it('swaps the form to another project, with its own values and no leftover message, when its button is pressed', async () => {
      const api = fakeApi([FLEET, ARMADA]);
      api.updateProject.mockRejectedValue(new ApiError(400, 'PATCH /api/projects/x', 'invalid_body'));
      await renderSettings(api);
      await screen.findByText('Armada');
      await userEvent.click(editTriggerOf('Fleet'));
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await screen.findByRole('alert');

      await userEvent.click(editTriggerOf('Armada'));

      expect(screen.getAllByRole('group')).toHaveLength(1);
      await waitFor(() => expect(nameField()).toHaveValue('Armada'));
      expect(docsFolderField()).toHaveValue('');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('swaps the creation form for the edit form, and back', async () => {
      await renderSettings(fakeApi([FLEET]));
      await screen.findByText('Fleet');
      await userEvent.click(createTrigger());

      await userEvent.click(editTriggerOf('Fleet'));
      expect(screen.getByRole('group', { name: 'Edit docs folder' })).toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Create a project' })).not.toBeInTheDocument();

      await userEvent.click(createTrigger());
      expect(screen.getByRole('group', { name: 'Create a project' })).toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Edit docs folder' })).not.toBeInTheDocument();
    });
  });
});
