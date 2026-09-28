import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { NewSessionFormComponent } from './new-session-form.component';
import { ApiError, FleetApiService } from '../core/fleet-api.service';

function fakeApi(overrides: Record<string, unknown> = {}) {
  return {
    createSession: vi.fn().mockResolvedValue({ id: 's-new' }),
    createManagerSession: vi.fn().mockResolvedValue({ id: 'm-new' }),
    ...overrides,
  };
}

async function renderForm(api: ReturnType<typeof fakeApi>, queryParams: Record<string, string> = {}) {
  const { fixture } = await render(NewSessionFormComponent, {
    providers: [
      provideRouter([]),
      { provide: FleetApiService, useValue: api },
      { provide: ActivatedRoute, useValue: { queryParamMap: of(convertToParamMap(queryParams)) } },
    ],
  });
  const navigateSpy = vi.spyOn(fixture.debugElement.injector.get(Router), 'navigate').mockResolvedValue(true);
  return { navigateSpy };
}

async function fillSessionFields({ directory = '/tmp/wt', name = 'Gimli' } = {}): Promise<void> {
  await userEvent.type(screen.getByTestId('new-session-directory'), directory);
  await userEvent.type(screen.getByTestId('new-session-name'), name);
}

async function fillManagerMission(mission = 'Ship phase 2'): Promise<void> {
  await userEvent.type(screen.getByTestId('manager-mission'), mission);
}

describe('NewSessionFormComponent', () => {
  it('user can create a session by typing a directory and a name', async () => {
    const api = fakeApi();
    await renderForm(api);

    await fillSessionFields();
    await userEvent.clear(screen.getByTestId('new-session-emoji'));
    await userEvent.type(screen.getByTestId('new-session-emoji'), '⚔️');
    await userEvent.selectOptions(screen.getByTestId('new-session-model'), 'opus');
    await userEvent.click(screen.getByTestId('new-session-submit'));

    expect(api.createSession).toHaveBeenCalledWith({
      directory: '/tmp/wt', name: 'Gimli', emoji: '⚔️', model: 'opus', harness: 'claude-cli',
    });
    expect(api.createManagerSession).not.toHaveBeenCalled();
  });

  it('user is taken to the new session once it is created', async () => {
    const api = fakeApi();
    const { navigateSpy } = await renderForm(api);

    await fillSessionFields();
    await userEvent.click(screen.getByTestId('new-session-submit'));

    expect(navigateSpy).toHaveBeenCalledWith(['/session', 's-new']);
  });

  it('user does not see the manager fields while creating a plain session', async () => {
    await renderForm(fakeApi());

    expect(screen.queryByTestId('manager-mission')).toBeNull();
    expect(screen.queryByTestId('manager-pulse-seconds')).toBeNull();
  });

  it('user can switch to manager mode and sees the pulse, children cap and mission fields', async () => {
    await renderForm(fakeApi());

    await userEvent.click(screen.getByTestId('new-session-mode-manager'));

    expect(screen.getByTestId('manager-pulse-seconds')).toBeTruthy();
    expect(screen.getByTestId('manager-children-cap')).toBeTruthy();
    expect(screen.getByTestId('manager-mission')).toBeTruthy();
  });

  it('user arriving from the "New manager" link starts in manager mode', async () => {
    await renderForm(fakeApi(), { mode: 'manager' });

    expect(screen.getByTestId('manager-mission')).toBeTruthy();
  });

  it('user can create a manager, sharing the workspace and identity fields with the session form', async () => {
    const api = fakeApi();
    const { navigateSpy } = await renderForm(api);

    await userEvent.click(screen.getByTestId('new-session-mode-manager'));
    await fillSessionFields({ name: 'Lead' });
    await userEvent.clear(screen.getByTestId('manager-pulse-seconds'));
    await userEvent.type(screen.getByTestId('manager-pulse-seconds'), '900');
    await userEvent.clear(screen.getByTestId('manager-children-cap'));
    await userEvent.type(screen.getByTestId('manager-children-cap'), '4');
    await fillManagerMission();
    await userEvent.click(screen.getByTestId('new-session-submit'));

    expect(api.createManagerSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/wt', name: 'Lead', pulseSeconds: 900, childrenCap: 4, mission: 'Ship phase 2', harness: 'claude-cli',
    }));
    expect(api.createSession).not.toHaveBeenCalled();
    expect(navigateSpy).toHaveBeenCalledWith(['/manager', 'm-new']);
  });

  it('user sees an inline error on the name and directory instead of a submit when both are empty', async () => {
    const api = fakeApi();
    await renderForm(api);

    await userEvent.click(screen.getByTestId('new-session-submit'));

    expect(screen.getByTestId('new-session-name-error')).toBeTruthy();
    expect(screen.getByTestId('new-session-directory-error')).toBeTruthy();
    expect(screen.getByTestId('new-session-name')).toHaveAttribute('aria-invalid', 'true');
    expect(api.createSession).not.toHaveBeenCalled();
  });

  it('user cannot create a manager without a mission', async () => {
    const api = fakeApi();
    await renderForm(api, { mode: 'manager' });

    await fillSessionFields({ name: 'Lead' });
    await userEvent.click(screen.getByTestId('new-session-submit'));

    expect(screen.getByTestId('manager-mission-error')).toBeTruthy();
    expect(api.createManagerSession).not.toHaveBeenCalled();
  });

  it('user sees a session created without a mission, since a mission only applies to managers', async () => {
    const api = fakeApi();
    await renderForm(api);

    await fillSessionFields();
    await userEvent.click(screen.getByTestId('new-session-submit'));

    expect(screen.queryByTestId('manager-mission-error')).toBeNull();
    expect(api.createSession).toHaveBeenCalledTimes(1);
  });

  it('user can only pick Claude Code as harness, the others are shown as not available yet', async () => {
    await renderForm(fakeApi());

    const harnessOptions = Array.from(screen.getByTestId('new-session-harness').querySelectorAll('option'));
    const enabledLabels = harnessOptions.filter((option) => !option.disabled).map((option) => option.value);
    const disabledOptions = harnessOptions.filter((option) => option.disabled);

    expect(enabledLabels).toEqual(['claude-cli']);
    expect(disabledOptions.length).toBe(3);
    disabledOptions.forEach((option) => expect(option).toHaveAttribute('title', 'not available yet'));
  });

  it('user is not offered bypassPermissions when creating a session', async () => {
    await renderForm(fakeApi());

    const offeredModes = Array.from(screen.getByTestId('new-session-permission-mode').querySelectorAll('option')).map((option) => option.value);

    expect(offeredModes).not.toContain('bypassPermissions');
    expect(offeredModes).toEqual(expect.arrayContaining(['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk']));
  });

  it('user can create a session with a chosen permission mode, and sees what the mode does', async () => {
    const api = fakeApi();
    await renderForm(api);

    await fillSessionFields();
    await userEvent.selectOptions(screen.getByTestId('new-session-permission-mode'), 'acceptEdits');
    expect(screen.getByTestId('new-session-permission-mode-explanation')).toHaveTextContent('File edits run without asking');
    await userEvent.click(screen.getByTestId('new-session-submit'));

    expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'acceptEdits' }));
  });

  it('user leaving the permission mode on inherited sends no permission mode', async () => {
    const api = fakeApi();
    await renderForm(api);

    await fillSessionFields();
    await userEvent.click(screen.getByTestId('new-session-submit'));

    expect(api.createSession.mock.calls[0]![0]).not.toHaveProperty('permissionMode');
  });

  it('user sees no "Test harness" button, since there is no backend probe to run', async () => {
    await renderForm(fakeApi());

    expect(screen.queryByRole('button', { name: /test harness/i })).toBeNull();
  });

  it('user sees the server error inline when the backend rejects the create', async () => {
    const api = fakeApi({ createSession: vi.fn().mockRejectedValue(new ApiError(400, 'directory must exist')) });
    const { navigateSpy } = await renderForm(api);

    await fillSessionFields();
    await userEvent.click(screen.getByTestId('new-session-submit'));

    expect(screen.getByTestId('new-session-form-error')).toHaveTextContent('directory must exist');
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('user cannot create twice by double-clicking while the request is pending', async () => {
    let resolveCreate!: (session: { id: string }) => void;
    const api = fakeApi({ createSession: vi.fn(() => new Promise((resolve) => { resolveCreate = resolve; })) });
    await renderForm(api);
    await fillSessionFields();

    await userEvent.click(screen.getByTestId('new-session-submit'));
    expect(screen.getByTestId('new-session-submit')).toBeDisabled();
    await userEvent.click(screen.getByTestId('new-session-submit'));

    expect(api.createSession).toHaveBeenCalledTimes(1);
    resolveCreate({ id: 's-new' });
  });

  it('user can cancel and go back to the sessions overview', async () => {
    await renderForm(fakeApi());

    expect(screen.getByTestId('new-session-cancel')).toHaveAttribute('href', '/');
  });

  it('gives the emoji, model and permission fields an accessible name for screen reader users', async () => {
    await renderForm(fakeApi());

    expect(screen.getByRole('textbox', { name: /emoji/i })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: /model/i })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: /permission mode/i })).toBeTruthy();
  });

  describe('manager fields', () => {
    async function renderManagerFormWithMinimalValidFields(api: ReturnType<typeof fakeApi>) {
      await renderForm(api, { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });
      await fillManagerMission();
    }

    it.each([
      ['0, below the 1..86400 minimum', '0'],
      ['86401, above the 1..86400 maximum', '86401'],
    ])('user cannot submit a pulse-seconds value of %s', async (_label, value) => {
      const api = fakeApi();
      await renderManagerFormWithMinimalValidFields(api);

      await userEvent.clear(screen.getByTestId('manager-pulse-seconds'));
      await userEvent.type(screen.getByTestId('manager-pulse-seconds'), value);
      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(api.createManagerSession).not.toHaveBeenCalled();
    });

    it.each([
      ['0, below the 1..64 minimum', '0'],
      ['65, above the 1..64 maximum', '65'],
    ])('user cannot submit a children-cap value of %s', async (_label, value) => {
      const api = fakeApi();
      await renderManagerFormWithMinimalValidFields(api);

      await userEvent.clear(screen.getByTestId('manager-children-cap'));
      await userEvent.type(screen.getByTestId('manager-children-cap'), value);
      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(api.createManagerSession).not.toHaveBeenCalled();
    });

    it('user sees the pulse-seconds error as soon as the field is left, and it clears once corrected', async () => {
      await renderForm(fakeApi(), { mode: 'manager' });
      const input = screen.getByTestId('manager-pulse-seconds');

      await userEvent.clear(input);
      await userEvent.type(input, '0');
      await userEvent.tab();
      const error = screen.getByTestId('manager-pulse-seconds-error');
      expect(error).toHaveTextContent('✕');
      expect(error).toHaveAttribute('role', 'alert');
      expect(input).toHaveAttribute('aria-invalid', 'true');

      await userEvent.clear(input);
      await userEvent.type(input, '1800');

      expect(screen.queryByTestId('manager-pulse-seconds-error')).toBeNull();
    });

    it('user sees the children-cap error as soon as the field is left', async () => {
      await renderForm(fakeApi(), { mode: 'manager' });

      await userEvent.clear(screen.getByTestId('manager-children-cap'));
      await userEvent.type(screen.getByTestId('manager-children-cap'), '65');
      await userEvent.tab();

      expect(screen.getByTestId('manager-children-cap-error')).toBeTruthy();
    });
  });
});
