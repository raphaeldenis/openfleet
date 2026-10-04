import { inputBinding, outputBinding, signal } from '@angular/core';
import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import type { Project } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { ProjectFormComponent } from './project-form.component';

const FLEET: Project = { id: '3f2b8c1e-5d4a-4b6e-9a7c-1d2e3f4a5b6c', name: 'Fleet', docsFolderPath: '/work/fleet-docs' };
const ARMADA: Project = { id: '9a1d7e52-0c3b-4f48-8d6a-2b5c7e9f1a30', name: 'Armada', docsFolderPath: null };

function fakeApi() {
  return {
    createProject: vi.fn().mockResolvedValue(FLEET),
    updateProject: vi.fn().mockResolvedValue(FLEET),
  };
}

async function renderForm(api: ReturnType<typeof fakeApi>, initialProject?: Project) {
  const saved = vi.fn();
  const cancelled = vi.fn();
  const project = signal(initialProject);
  const { fixture } = await render(ProjectFormComponent, {
    bindings: [inputBinding('project', project), outputBinding('saved', saved), outputBinding('cancelled', cancelled)],
    providers: [{ provide: FleetApiService, useValue: api }],
  });
  return { saved, cancelled, fixture, project };
}

const nameField = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' });
const docsFolderField = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Docs folder' });
const createButton = () => screen.getByRole('button', { name: 'Create project' });
const saveButton = () => screen.getByRole('button', { name: 'Save' });

async function createProjectNamed(name: string, docsFolder = ''): Promise<void> {
  await userEvent.type(nameField(), name);
  if (docsFolder) await userEvent.type(docsFolderField(), docsFolder);
  await userEvent.click(createButton());
}

describe('the project form', () => {
  describe('when it creates a project', () => {
    it('creates the project with the trimmed name and the docs folder, then reports it as saved', async () => {
      const api = fakeApi();
      const { saved } = await renderForm(api);

      await createProjectNamed('  Fleet  ', '/work/fleet-docs');

      expect(api.createProject).toHaveBeenCalledExactlyOnceWith({ name: 'Fleet', docsFolderPath: '/work/fleet-docs' });
      await waitFor(() => expect(saved).toHaveBeenCalledExactlyOnceWith(FLEET));
    });

    it('creates the project without a docs folder when the field is left blank', async () => {
      const api = fakeApi();
      await renderForm(api);

      await createProjectNamed('Fleet', '   ');

      expect(api.createProject).toHaveBeenCalledExactlyOnceWith({ name: 'Fleet' });
    });

    it('puts the cursor in the Name field when it opens', async () => {
      await renderForm(fakeApi());

      await waitFor(() => expect(nameField()).toHaveFocus());
    });

    it('tells, in a hint tied to the Docs folder field, that the path is optional and typed by hand', async () => {
      await renderForm(fakeApi());

      const hint = screen.getByText(/Optional\. Type the absolute path of an existing folder/);

      expect(docsFolderField()).toHaveAccessibleDescription(hint.textContent!);
    });

    it('ignores a second press while the daemon is still answering', async () => {
      const api = fakeApi();
      api.createProject.mockImplementation(() => new Promise(() => undefined));
      await renderForm(api);
      await userEvent.type(nameField(), 'Fleet');

      await userEvent.click(createButton());
      await userEvent.click(createButton());

      expect(api.createProject).toHaveBeenCalledOnce();
      expect(createButton()).toHaveAttribute('aria-disabled', 'true');
    });

    it('creates the project when Enter is pressed in a field', async () => {
      const api = fakeApi();
      const { saved } = await renderForm(api);
      await userEvent.type(nameField(), 'Fleet');

      await userEvent.keyboard('{Enter}');

      expect(api.createProject).toHaveBeenCalledOnce();
      await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    });
  });

  describe('when the name is not valid', () => {
    it('asks for a name, focuses the field, and tells assistive technology which field and why', async () => {
      const api = fakeApi();
      await renderForm(api);

      await userEvent.click(createButton());

      const error = await screen.findByText('Name is required');
      expect(api.createProject).not.toHaveBeenCalled();
      await waitFor(() => expect(nameField()).toHaveFocus());
      expect(nameField()).toBeInvalid();
      expect(nameField()).toHaveAccessibleDescription('Name is required');
      expect(error).toHaveAttribute('role', 'alert');
    });

    it('treats a name of spaces as missing', async () => {
      const api = fakeApi();
      await renderForm(api);

      await createProjectNamed('   ');

      expect(await screen.findByText('Name is required')).toBeInTheDocument();
      expect(api.createProject).not.toHaveBeenCalled();
    });

    it('refuses a name longer than 80 characters', async () => {
      const api = fakeApi();
      await renderForm(api);

      await userEvent.click(nameField());
      await userEvent.paste('x'.repeat(81));
      await userEvent.click(createButton());

      expect(await screen.findByText('The name must be 80 characters or fewer')).toBeInTheDocument();
      expect(api.createProject).not.toHaveBeenCalled();
    });

    it('accepts a name of exactly 80 characters', async () => {
      const api = fakeApi();
      await renderForm(api);

      await userEvent.click(nameField());
      await userEvent.paste('x'.repeat(80));
      await userEvent.click(createButton());

      expect(api.createProject).toHaveBeenCalledOnce();
    });
  });

  describe('when the daemon refuses the project', () => {
    const refusedWith = (code: string, status = 400) => new ApiError(status, 'POST /api/projects', code);

    it.each([
      ['invalid_body', 'That folder cannot be used: use an existing absolute folder path.'],
      ['docs_folder_not_writable', 'That folder is not writable — fix its permissions, then try again.'],
      ['path_escapes_docs_folder', 'That folder contains a link that leads outside it — pick a folder without one.'],
    ])('explains %s politely, ties the message to the Docs folder field and puts the cursor there', async (code, sentence) => {
      const api = fakeApi();
      api.createProject.mockRejectedValue(refusedWith(code));
      await renderForm(api);

      await createProjectNamed('Fleet', '/nope');

      const error = await screen.findByRole('alert');
      expect(error).toHaveTextContent(sentence);
      expect(docsFolderField()).toBeInvalid();
      expect(docsFolderField().getAttribute('aria-describedby')!.split(' ')).toContain(error.id);
      await waitFor(() => expect(docsFolderField()).toHaveFocus());
      expect(nameField()).toBeValid();
    });

    it('words invalid_body exactly as the copy table says', async () => {
      const api = fakeApi();
      api.createProject.mockRejectedValue(refusedWith('invalid_body'));
      await renderForm(api);

      await createProjectNamed('Fleet', 'relative/path');

      expect(await screen.findByRole('alert')).toHaveTextContent('That folder cannot be used: use an existing absolute folder path.');
    });

    it('says the project was not saved, without blaming a field, when the daemon cannot be reached', async () => {
      const api = fakeApi();
      api.createProject.mockRejectedValue(new TypeError('Failed to fetch'));
      await renderForm(api);

      await createProjectNamed('Fleet', '/work/docs');

      expect(await screen.findByRole('alert')).toHaveTextContent('The project was not saved — check your connection, then try again.');
      expect(docsFolderField()).toBeValid();
    });

    it('clears the message as soon as the user edits the folder, and lets them try again', async () => {
      const api = fakeApi();
      api.createProject.mockRejectedValueOnce(refusedWith('invalid_body'));
      const { saved } = await renderForm(api);
      await createProjectNamed('Fleet', '/nope');
      await screen.findByRole('alert');

      await userEvent.type(docsFolderField(), '2');

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(docsFolderField()).toBeValid();
      await userEvent.click(createButton());
      await waitFor(() => expect(saved).toHaveBeenCalledOnce());
      expect(api.createProject).toHaveBeenCalledTimes(2);
    });

    it('keeps the form open and unsaved', async () => {
      const api = fakeApi();
      api.createProject.mockRejectedValue(refusedWith('invalid_body'));
      const { saved, cancelled } = await renderForm(api);

      await createProjectNamed('Fleet', '/nope');
      await screen.findByRole('alert');

      expect(saved).not.toHaveBeenCalled();
      expect(cancelled).not.toHaveBeenCalled();
      expect(nameField()).toHaveValue('Fleet');
    });

    it('reports an answer that is not a project as a failure to save', async () => {
      const api = fakeApi();
      api.createProject.mockRejectedValue(new ApiError(200, 'POST /api/projects → unreadable project'));
      const { saved } = await renderForm(api);

      await createProjectNamed('Fleet');

      expect(await screen.findByRole('alert')).toHaveTextContent('The project was not saved — try again.');
      expect(saved).not.toHaveBeenCalled();
    });
  });

  describe('when the user changes their mind', () => {
    it('reports the cancellation from the Cancel button', async () => {
      const { cancelled } = await renderForm(fakeApi());

      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(cancelled).toHaveBeenCalledOnce();
    });

    it('reports the cancellation from Escape, and keeps Escape to itself', async () => {
      const outerEscape = vi.fn();
      document.addEventListener('keydown', outerEscape);
      const { cancelled } = await renderForm(fakeApi());

      await userEvent.type(nameField(), 'Fle{Escape}');

      expect(cancelled).toHaveBeenCalledOnce();
      expect(outerEscape).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }));
      document.removeEventListener('keydown', outerEscape);
    });
  });

  describe('when it edits the docs folder of a project', () => {
    it('shows the project name and docs folder, and puts the cursor in the Docs folder field', async () => {
      await renderForm(fakeApi(), FLEET);

      expect(nameField()).toHaveValue('Fleet');
      expect(docsFolderField()).toHaveValue('/work/fleet-docs');
      await waitFor(() => expect(docsFolderField()).toHaveFocus());
    });

    it('patches only the docs folder when the name is untouched, then reports the updated project', async () => {
      const api = fakeApi();
      const { saved } = await renderForm(api, ARMADA);

      await userEvent.type(docsFolderField(), '/work/armada-docs');
      await userEvent.click(saveButton());

      expect(api.updateProject).toHaveBeenCalledExactlyOnceWith(ARMADA.id, { docsFolderPath: '/work/armada-docs' });
      expect(api.createProject).not.toHaveBeenCalled();
      await waitFor(() => expect(saved).toHaveBeenCalledExactlyOnceWith(FLEET));
    });

    it('patches the new name too when the user renames the project', async () => {
      const api = fakeApi();
      await renderForm(api, FLEET);

      await userEvent.clear(nameField());
      await userEvent.type(nameField(), ' Fleet 2 ');
      await userEvent.click(saveButton());

      expect(api.updateProject).toHaveBeenCalledExactlyOnceWith(FLEET.id, { name: 'Fleet 2', docsFolderPath: '/work/fleet-docs' });
    });

    it('asks for a docs folder, since the daemon cannot remove one, and focuses the field', async () => {
      const api = fakeApi();
      await renderForm(api, ARMADA);

      await userEvent.click(saveButton());

      expect(await screen.findByText('Docs folder is required')).toBeInTheDocument();
      expect(api.updateProject).not.toHaveBeenCalled();
      await waitFor(() => expect(docsFolderField()).toHaveFocus());
      expect(docsFolderField()).toBeInvalid();
    });

    it('explains a refused folder the same way as when creating', async () => {
      const api = fakeApi();
      api.updateProject.mockRejectedValue(new ApiError(400, 'PATCH /api/projects/x', 'invalid_body'));
      await renderForm(api, FLEET);

      await userEvent.click(saveButton());

      expect(await screen.findByRole('alert')).toHaveTextContent('That folder cannot be used: use an existing absolute folder path.');
    });

    it('shows the values of another project when it is handed one', async () => {
      const { fixture, project } = await renderForm(fakeApi(), FLEET);

      project.set(ARMADA);
      await fixture.whenStable();

      await waitFor(() => expect(nameField()).toHaveValue('Armada'));
      expect(docsFolderField()).toHaveValue('');
    });
  });
});
