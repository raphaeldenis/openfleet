import { inputBinding, outputBinding, signal } from '@angular/core';
import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import type { Project } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { ProjectHookSettingComponent } from './project-hook-setting.component';

const WITHOUT_HOOK: Project = { id: 'p-fleet', name: 'Fleet', docsFolderPath: null };
const WITH_HOOK: Project = { ...WITHOUT_HOOK, postCreateHookScript: '/hooks/setup.sh', postCreateHookTimeoutSeconds: 90 };

function fakeApi(saved: Project = WITH_HOOK) {
  return { updateProject: vi.fn((): Promise<Project> => Promise.resolve(saved)) };
}

async function renderSetting(project: Project, api = fakeApi()) {
  const savedProject = vi.fn();
  const current = signal(project);
  await render(ProjectHookSettingComponent, {
    bindings: [inputBinding('project', current), outputBinding('saved', savedProject)],
    providers: [{ provide: FleetApiService, useValue: api }],
  });
  return { api, savedProject, current };
}

const scriptField = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Script path' });
const timeoutField = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Timeout in seconds' });
const saveButton = () => screen.getByRole('button', { name: 'Save' });
const openEditor = (name: 'Change…' | 'Set a hook…') => userEvent.click(screen.getByRole('button', { name }));

describe('the post-create hook setting of a project', () => {
  describe('reading', () => {
    it('user sees that no hook is set', async () => {
      await renderSetting(WITHOUT_HOOK);

      expect(screen.getByText('No hook')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Set a hook…' })).toBeInTheDocument();
    });

    it('user sees the script and its timeout', async () => {
      await renderSetting(WITH_HOOK);

      expect(screen.getByText('/hooks/setup.sh')).toBeInTheDocument();
      expect(screen.getByText('Times out after 90 s')).toBeInTheDocument();
    });

    it('user sees the default timeout when the project names none', async () => {
      await renderSetting({ ...WITH_HOOK, postCreateHookTimeoutSeconds: undefined });

      expect(screen.getByText('Times out after 60 s (default)')).toBeInTheDocument();
    });

    it('user reads the security warning before editing and while editing', async () => {
      await renderSetting(WITHOUT_HOOK);
      expect(screen.getByText(/runs on this computer as the daemon's user/)).toBeInTheDocument();

      await openEditor('Set a hook…');

      expect(screen.getByText(/runs on this computer as the daemon's user/)).toBeInTheDocument();
      expect(screen.getByText(/only you can write/)).toBeInTheDocument();
    });
  });

  describe('saving', () => {
    it('saves the trimmed script and the timeout, then reports the project the daemon returns', async () => {
      const { api, savedProject } = await renderSetting(WITHOUT_HOOK);
      await openEditor('Set a hook…');

      await userEvent.type(scriptField(), '  /hooks/setup.sh  ');
      await userEvent.type(timeoutField(), '90');
      await userEvent.click(saveButton());

      expect(api.updateProject).toHaveBeenCalledExactlyOnceWith('p-fleet', { postCreateHookScript: '/hooks/setup.sh', postCreateHookTimeoutSeconds: 90 });
      await waitFor(() => expect(savedProject).toHaveBeenCalledExactlyOnceWith(WITH_HOOK));
      expect(screen.queryByRole('textbox', { name: 'Script path' })).not.toBeInTheDocument();
    });

    it('saves with Enter, and clears the timeout when it is left empty', async () => {
      const { api } = await renderSetting(WITHOUT_HOOK);
      await openEditor('Set a hook…');

      await userEvent.type(scriptField(), '/hooks/setup.sh{Enter}');

      expect(api.updateProject).toHaveBeenCalledExactlyOnceWith('p-fleet', { postCreateHookScript: '/hooks/setup.sh', postCreateHookTimeoutSeconds: null });
    });

    it('starts from the current script and timeout, and Escape closes without saving', async () => {
      const { api } = await renderSetting(WITH_HOOK);
      await openEditor('Change…');

      expect(scriptField()).toHaveValue('/hooks/setup.sh');
      expect(timeoutField()).toHaveValue('90');
      await userEvent.keyboard('{Escape}');

      expect(screen.queryByRole('textbox', { name: 'Script path' })).not.toBeInTheDocument();
      expect(api.updateProject).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Change…' })).toHaveFocus());
    });

    it('moves the focus to the script field when the editor opens', async () => {
      await renderSetting(WITHOUT_HOOK);

      await openEditor('Set a hook…');

      await waitFor(() => expect(scriptField()).toHaveFocus());
    });

    it('sends a single request when the user saves twice in a row', async () => {
      const api = fakeApi();
      api.updateProject.mockImplementation(() => new Promise(() => undefined));
      await renderSetting(WITHOUT_HOOK, api);
      await openEditor('Set a hook…');
      await userEvent.type(scriptField(), '/hooks/setup.sh');

      await userEvent.dblClick(saveButton());

      expect(api.updateProject).toHaveBeenCalledTimes(1);
    });
  });

  describe('validation', () => {
    it('asks for a script and sends nothing when the field is empty', async () => {
      const { api } = await renderSetting(WITHOUT_HOOK);
      await openEditor('Set a hook…');

      await userEvent.click(saveButton());

      expect(await screen.findByRole('alert')).toHaveTextContent('Script path is required');
      expect(scriptField()).toHaveAttribute('aria-invalid', 'true');
      await waitFor(() => expect(scriptField()).toHaveFocus());
      expect(api.updateProject).not.toHaveBeenCalled();
    });

    it('asks for an absolute path when the script is relative', async () => {
      const { api } = await renderSetting(WITHOUT_HOOK);
      await openEditor('Set a hook…');

      await userEvent.type(scriptField(), 'setup.sh');
      await userEvent.click(saveButton());

      expect(await screen.findByRole('alert')).toHaveTextContent('Use an absolute path, starting with /');
      expect(api.updateProject).not.toHaveBeenCalled();
    });

    it.each(['0', '601', '1.5', 'abc'])('rejects the timeout %s and says the allowed range', async (timeout) => {
      const { api } = await renderSetting(WITHOUT_HOOK);
      await openEditor('Set a hook…');

      await userEvent.type(scriptField(), '/hooks/setup.sh');
      await userEvent.type(timeoutField(), timeout);
      await userEvent.click(saveButton());

      expect(await screen.findByRole('alert')).toHaveTextContent('The timeout is a whole number of seconds from 1 to 600');
      expect(timeoutField()).toHaveAttribute('aria-invalid', 'true');
      expect(api.updateProject).not.toHaveBeenCalled();
    });

    it('accepts the bounds 1 and 600', async () => {
      const { api } = await renderSetting(WITHOUT_HOOK);
      await openEditor('Set a hook…');

      await userEvent.type(scriptField(), '/hooks/setup.sh');
      await userEvent.type(timeoutField(), '600');
      await userEvent.click(saveButton());

      expect(api.updateProject).toHaveBeenCalledExactlyOnceWith('p-fleet', { postCreateHookScript: '/hooks/setup.sh', postCreateHookTimeoutSeconds: 600 });
    });
  });

  describe('when the daemon refuses', () => {
    it('says the script cannot be used, in words, and keeps what the user typed', async () => {
      const api = fakeApi();
      const envelope = { error: 'invalid_body' as const, kind: 'invalid_request' as const, retry: 'never' as const, message: 'raw daemon words' };
      api.updateProject.mockRejectedValue(new ApiError(400, 'PATCH /x', 'invalid_body', envelope));
      await renderSetting(WITHOUT_HOOK, api);
      await openEditor('Set a hook…');

      await userEvent.type(scriptField(), '/hooks/not-executable.sh');
      await userEvent.click(saveButton());

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('That script cannot be used: give the absolute path of an executable file that only you can write.');
      expect(alert).not.toHaveTextContent(/invalid_body|raw daemon words|400/);
      expect(scriptField()).toHaveValue('/hooks/not-executable.sh');
    });

    it('says the hook was not saved when the daemon cannot be reached, and a new attempt can succeed', async () => {
      const api = fakeApi();
      api.updateProject.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const { savedProject } = await renderSetting(WITHOUT_HOOK, api);
      await openEditor('Set a hook…');
      await userEvent.type(scriptField(), '/hooks/setup.sh');

      await userEvent.click(saveButton());

      expect(await screen.findByRole('alert')).toHaveTextContent('The hook was not saved — check your connection, then try again.');
      await userEvent.click(saveButton());
      await waitFor(() => expect(savedProject).toHaveBeenCalledTimes(1));
    });
  });

  describe('removing the hook', () => {
    it('offers Remove hook only when a hook is set, and clears the script', async () => {
      const { api, savedProject } = await renderSetting(WITH_HOOK, fakeApi(WITHOUT_HOOK));
      await openEditor('Change…');

      await userEvent.click(screen.getByRole('button', { name: 'Remove hook' }));

      expect(api.updateProject).toHaveBeenCalledExactlyOnceWith('p-fleet', { postCreateHookScript: null });
      await waitFor(() => expect(savedProject).toHaveBeenCalledExactlyOnceWith(WITHOUT_HOOK));
    });

    it('does not offer Remove hook when no hook is set', async () => {
      await renderSetting(WITHOUT_HOOK);
      await openEditor('Set a hook…');

      expect(screen.queryByRole('button', { name: 'Remove hook' })).not.toBeInTheDocument();
    });
  });

  describe('switching project', () => {
    it('shows the hook of the new project and closes an editor left open for the previous one', async () => {
      const { current } = await renderSetting(WITH_HOOK);
      await openEditor('Change…');

      current.set({ id: 'p-armada', name: 'Armada', docsFolderPath: null });

      expect(await screen.findByText('No hook')).toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'Script path' })).not.toBeInTheDocument();
    });
  });
});
