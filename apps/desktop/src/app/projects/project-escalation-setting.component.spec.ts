import { inputBinding, outputBinding, signal } from '@angular/core';
import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { DEFAULT_ESCALATION_POLICY, ESCALATING_CLASSES, type Project } from '@openfleet/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { ProjectEscalationSettingComponent } from './project-escalation-setting.component';

const WITHOUT_POLICY: Project = { id: 'p-fleet', name: 'Fleet', docsFolderPath: null };
const WITHOUT_SPEND: Project = { ...WITHOUT_POLICY, escalation: { ...DEFAULT_ESCALATION_POLICY, humanClasses: ESCALATING_CLASSES.filter((name) => name !== 'spend') } };

function fakeApi(saved: Project = WITHOUT_SPEND) {
  return { updateProject: vi.fn((): Promise<Project> => Promise.resolve(saved)) };
}

async function renderSetting(project: Project, api: { updateProject: ReturnType<typeof vi.fn> } = fakeApi()) {
  const current = signal(project);
  const savedProject = vi.fn((saved: Project) => current.set(saved));
  await render(ProjectEscalationSettingComponent, {
    bindings: [inputBinding('project', current), outputBinding('saved', savedProject)],
    providers: [{ provide: FleetApiService, useValue: api }],
  });
  return { api, savedProject, current };
}

const classBox = (name: string) => screen.getByRole<HTMLInputElement>('checkbox', { name });

describe('the escalation policy setting of a project', () => {
  describe('reading', () => {
    it('user sees the seven escalating classes, all on the human list by default', async () => {
      await renderSetting(WITHOUT_POLICY);

      expect(screen.getAllByRole('checkbox')).toHaveLength(7);
      for (const checkbox of screen.getAllByRole<HTMLInputElement>('checkbox')) expect(checkbox.checked).toBe(true);
    });

    it('user sees a class the project took off its human list unchecked', async () => {
      await renderSetting(WITHOUT_SPEND);

      expect(classBox('spend').checked).toBe(false);
      expect(classBox('deployment').checked).toBe(true);
    });

    it('user sees contract and security locked, with the reason', async () => {
      await renderSetting(WITHOUT_POLICY);

      expect(classBox('contract')).toBeDisabled();
      expect(classBox('security')).toBeDisabled();
      expect(screen.getAllByText('Always escalated')).toHaveLength(2);
      expect(classBox('spend')).toBeEnabled();
    });
  });

  describe('changing', () => {
    it('sends the whole policy without the class the user unchecks, and tells the host the saved project', async () => {
      const { api, savedProject } = await renderSetting(WITHOUT_POLICY);

      await userEvent.click(classBox('spend'));

      expect(api.updateProject).toHaveBeenCalledExactlyOnceWith('p-fleet', { escalation: WITHOUT_SPEND.escalation });
      await waitFor(() => expect(savedProject).toHaveBeenCalledExactlyOnceWith(WITHOUT_SPEND));
    });

    it('sends the class back on the list when the user checks it again', async () => {
      const api = fakeApi({ ...WITHOUT_POLICY, escalation: DEFAULT_ESCALATION_POLICY });
      await renderSetting(WITHOUT_SPEND, api);

      await userEvent.click(classBox('spend'));

      expect(api.updateProject).toHaveBeenCalledExactlyOnceWith('p-fleet', { escalation: DEFAULT_ESCALATION_POLICY });
    });

    it('does not send anything when the user clicks a locked class', async () => {
      const { api } = await renderSetting(WITHOUT_POLICY);

      await userEvent.click(classBox('contract'));

      expect(api.updateProject).not.toHaveBeenCalled();
    });

    it('shows the copy of the daemon refusal and keeps the class as it was', async () => {
      const updateProject = vi.fn().mockRejectedValue(new ApiError(400, 'invalid_body', 'invalid_body'));
      const { savedProject } = await renderSetting(WITHOUT_POLICY, { updateProject });

      await userEvent.click(classBox('spend'));

      expect(await screen.findByRole('alert')).toHaveTextContent('contract and security always stay');
      expect(classBox('spend').checked).toBe(true);
      expect(savedProject).not.toHaveBeenCalled();
    });

    it('shows that the project is gone when the daemon cannot find it', async () => {
      const updateProject = vi.fn().mockRejectedValue(new ApiError(404, 'project_not_found', 'project_not_found'));
      await renderSetting(WITHOUT_POLICY, { updateProject });

      await userEvent.click(classBox('spend'));

      expect(await screen.findByRole('alert')).toHaveTextContent('That project no longer exists');
    });

    it('keeps the boxes locked while a change is in flight', async () => {
      let finish: (project: Project) => void = () => undefined;
      const updateProject = vi.fn(() => new Promise<Project>((resolve) => { finish = resolve; }));
      await renderSetting(WITHOUT_POLICY, { updateProject });

      await userEvent.click(classBox('spend'));

      expect(classBox('deployment')).toBeDisabled();
      finish(WITHOUT_SPEND);
      await waitFor(() => expect(classBox('deployment')).toBeEnabled());
    });
  });
});
