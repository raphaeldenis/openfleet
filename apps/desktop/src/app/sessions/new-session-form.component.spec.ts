import { fireEvent, render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
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
  const queryParamMap$ = new BehaviorSubject(convertToParamMap(queryParams));
  const { fixture } = await render(NewSessionFormComponent, {
    providers: [
      provideRouter([]),
      { provide: FleetApiService, useValue: api },
      { provide: ActivatedRoute, useValue: { queryParamMap: queryParamMap$ } },
    ],
  });
  const navigateSpy = vi.spyOn(fixture.debugElement.injector.get(Router), 'navigate').mockResolvedValue(true);
  const changeUrlQueryParams = (nextQueryParams: Record<string, string>) => queryParamMap$.next(convertToParamMap(nextQueryParams));
  return { fixture, navigateSpy, changeUrlQueryParams };
}

async function pasteMission(mission: string): Promise<void> {
  await userEvent.click(screen.getByTestId('manager-mission'));
  await userEvent.paste(mission);
}

async function setNumberField(testId: string, value: string): Promise<void> {
  await userEvent.clear(screen.getByTestId(testId));
  if (value !== '') await userEvent.type(screen.getByTestId(testId), value);
}

const MISSION_MAX_BYTES = 64 * 1024;

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

  describe('input hygiene', () => {
    it('user typing stray spaces around the directory and name creates the session with them trimmed', async () => {
      const api = fakeApi();
      await renderForm(api);

      await fillSessionFields({ directory: '  /tmp/wt  ', name: '  Gimli  ' });
      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ directory: '/tmp/wt', name: 'Gimli' }));
    });

    it('user typing only spaces in the directory and name is told both are required', async () => {
      const api = fakeApi();
      await renderForm(api);

      await fillSessionFields({ directory: '   ', name: '   ' });
      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(screen.getByTestId('new-session-directory-error')).toBeTruthy();
      expect(screen.getByTestId('new-session-name-error')).toBeTruthy();
      expect(api.createSession).not.toHaveBeenCalled();
    });

    it('user typing stray spaces around the mission creates the manager with it trimmed', async () => {
      const api = fakeApi();
      await renderForm(api, { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });

      await pasteMission('  Ship phase 2  \n');
      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(api.createManagerSession).toHaveBeenCalledWith(expect.objectContaining({ mission: 'Ship phase 2' }));
    });

    it('user sees the name error clear as soon as a name is typed', async () => {
      await renderForm(fakeApi());
      await userEvent.click(screen.getByTestId('new-session-submit'));

      await userEvent.type(screen.getByTestId('new-session-name'), 'G');

      expect(screen.queryByTestId('new-session-name-error')).toBeNull();
    });

    it('user with an unknown ?mode= value gets the plain session form', async () => {
      await renderForm(fakeApi(), { mode: 'bogus' });

      expect(screen.queryByTestId('manager-mission')).toBeNull();
      expect(screen.getByTestId('new-session-mode-session')).toHaveAttribute('aria-pressed', 'true');
    });
  });

  describe('submitting', () => {
    it('user pressing Enter in the name field creates the session once', async () => {
      const api = fakeApi();
      await renderForm(api);
      await userEvent.type(screen.getByTestId('new-session-directory'), '/tmp/wt');

      await userEvent.type(screen.getByTestId('new-session-name'), 'Gimli{enter}');

      expect(api.createSession).toHaveBeenCalledTimes(1);
    });

    it('user switching to manager mode is not shown validation errors, since the toggle does not submit', async () => {
      const api = fakeApi();
      await renderForm(api);

      await userEvent.click(screen.getByTestId('new-session-mode-manager'));

      expect(screen.queryByTestId('new-session-name-error')).toBeNull();
      expect(screen.queryByTestId('new-session-directory-error')).toBeNull();
      expect(api.createManagerSession).not.toHaveBeenCalled();
    });

    it('user cannot create twice when the form is submitted again while the request is pending', async () => {
      let resolveCreate!: (session: { id: string }) => void;
      const api = fakeApi({ createSession: vi.fn(() => new Promise((resolve) => { resolveCreate = resolve; })) });
      await renderForm(api);
      await fillSessionFields();

      const form = screen.getByTestId('new-session-form');
      fireEvent.submit(form);
      fireEvent.submit(form);

      expect(api.createSession).toHaveBeenCalledTimes(1);
      resolveCreate({ id: 's-new' });
    });

    it('user keeps what was typed, can retry and is not navigated away after the backend rejects the create', async () => {
      const createSession = vi.fn().mockRejectedValueOnce(new ApiError(500, 'boom')).mockResolvedValueOnce({ id: 's-new' });
      const { navigateSpy } = await renderForm(fakeApi({ createSession }));
      await fillSessionFields();

      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(screen.getByTestId('new-session-directory')).toHaveValue('/tmp/wt');
      expect(screen.getByTestId('new-session-name')).toHaveValue('Gimli');
      expect(screen.getByTestId('new-session-submit')).toBeEnabled();
      expect(navigateSpy).not.toHaveBeenCalled();

      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(createSession).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('new-session-form-error')).toBeNull();
      expect(navigateSpy).toHaveBeenCalledWith(['/session', 's-new']);
    });

    it('user sees a connection hint when the request fails without an API response', async () => {
      const api = fakeApi({ createSession: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) });
      await renderForm(api);
      await fillSessionFields();

      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(screen.getByTestId('new-session-form-error')).toHaveTextContent('check your connection');
    });

    it('user who left the form before the create resolves is not pulled back to the new session', async () => {
      let resolveCreate!: (session: { id: string }) => void;
      const api = fakeApi({ createSession: vi.fn(() => new Promise((resolve) => { resolveCreate = resolve; })) });
      const { fixture, navigateSpy } = await renderForm(api);
      await fillSessionFields();
      await userEvent.click(screen.getByTestId('new-session-submit'));

      fixture.destroy();
      resolveCreate({ id: 's-late' });
      await new Promise((resolve) => setTimeout(resolve));

      expect(navigateSpy).not.toHaveBeenCalled();
    });
  });

  describe('toggling between session and manager', () => {
    it('user toggling to manager and back keeps every typed value', async () => {
      await renderForm(fakeApi());
      await fillSessionFields();
      await userEvent.selectOptions(screen.getByTestId('new-session-model'), 'opus');
      await userEvent.selectOptions(screen.getByTestId('new-session-permission-mode'), 'plan');
      await userEvent.click(screen.getByTestId('new-session-mode-manager'));
      await setNumberField('manager-pulse-seconds', '900');
      await setNumberField('manager-children-cap', '4');
      await fillManagerMission('Ship it');

      await userEvent.click(screen.getByTestId('new-session-mode-session'));
      await userEvent.click(screen.getByTestId('new-session-mode-manager'));

      await waitFor(() => expect(screen.getByTestId('manager-mission')).toHaveValue('Ship it'));
      expect(screen.getByTestId('manager-pulse-seconds')).toHaveValue(900);
      expect(screen.getByTestId('manager-children-cap')).toHaveValue(4);
      expect(screen.getByTestId('new-session-directory')).toHaveValue('/tmp/wt');
      expect(screen.getByTestId('new-session-name')).toHaveValue('Gimli');
      expect(screen.getByTestId('new-session-model')).toHaveValue('opus');
      expect(screen.getByTestId('new-session-permission-mode')).toHaveValue('plan');
    });

    it('user switching to manager puts ?mode=manager in the URL without adding a history entry', async () => {
      const { navigateSpy } = await renderForm(fakeApi());

      await userEvent.click(screen.getByTestId('new-session-mode-manager'));

      expect(navigateSpy).toHaveBeenCalledWith([], expect.objectContaining({ queryParams: { mode: 'manager' }, replaceUrl: true }));
    });

    it('user switching back to session removes the mode from the URL', async () => {
      const { navigateSpy } = await renderForm(fakeApi(), { mode: 'manager' });

      await userEvent.click(screen.getByTestId('new-session-mode-session'));

      expect(navigateSpy).toHaveBeenCalledWith([], expect.objectContaining({ queryParams: {}, replaceUrl: true }));
    });

    it('user following a sidebar link while the form is open sees the form follow the URL', async () => {
      const { changeUrlQueryParams } = await renderForm(fakeApi());
      expect(screen.queryByTestId('manager-mission')).toBeNull();

      changeUrlQueryParams({ mode: 'manager' });
      await waitFor(() => expect(screen.getByTestId('manager-mission')).toBeTruthy());
      expect(screen.getByTestId('new-session-mode-manager')).toHaveAttribute('aria-pressed', 'true');

      changeUrlQueryParams({});
      await waitFor(() => expect(screen.queryByTestId('manager-mission')).toBeNull());
    });

    it('user creating a manager with a chosen permission mode sends the mode and harness along', async () => {
      const api = fakeApi();
      await renderForm(api, { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });
      await fillManagerMission();
      await userEvent.selectOptions(screen.getByTestId('new-session-permission-mode'), 'plan');

      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(api.createManagerSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'plan', harness: 'claude-cli' }));
    });

    it('user leaving the permission mode on inherited creates a manager with no permission mode', async () => {
      const api = fakeApi();
      await renderForm(api, { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });
      await fillManagerMission();

      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(api.createManagerSession.mock.calls[0]![0]).not.toHaveProperty('permissionMode');
    });
  });

  describe('labels', () => {
    it('gives the directory, name and harness fields an accessible name for screen reader users', async () => {
      await renderForm(fakeApi());

      expect(screen.getByRole('textbox', { name: /directory/i })).toBeTruthy();
      expect(screen.getByRole('textbox', { name: /name/i })).toBeTruthy();
      expect(screen.getByRole('combobox', { name: /harness/i })).toBeTruthy();
    });

    it('gives the pulse, children cap and mission fields an accessible name for screen reader users', async () => {
      await renderForm(fakeApi(), { mode: 'manager' });

      expect(screen.getByRole('spinbutton', { name: /pulse seconds/i })).toBeTruthy();
      expect(screen.getByRole('spinbutton', { name: /children cap/i })).toBeTruthy();
      expect(screen.getByRole('textbox', { name: /mission/i })).toBeTruthy();
    });

    it('keeps the field name as its accessible name while its error is shown', async () => {
      await renderForm(fakeApi());

      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(screen.getByTestId('new-session-name')).toHaveAccessibleName('Name');
    });

    it('describes each invalid field with its error message', async () => {
      await renderForm(fakeApi(), { mode: 'manager' });

      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(screen.getByTestId('new-session-directory')).toHaveAccessibleDescription('✕ Directory is required');
      expect(screen.getByTestId('new-session-name')).toHaveAccessibleDescription('✕ Name is required');
      expect(screen.getByTestId('manager-mission')).toHaveAccessibleDescription('✕ A manager needs a mission');
    });

    it('describes the pulse seconds and children cap fields with their errors while keeping their names', async () => {
      await renderForm(fakeApi(), { mode: 'manager' });

      await setNumberField('manager-pulse-seconds', '0');
      await setNumberField('manager-children-cap', '65');
      await userEvent.tab();

      expect(screen.getByTestId('manager-pulse-seconds')).toHaveAccessibleName('Pulse seconds');
      expect(screen.getByTestId('manager-pulse-seconds')).toHaveAccessibleDescription(/whole number between 1 and 86400/);
      expect(screen.getByTestId('manager-children-cap')).toHaveAccessibleName('Children cap');
      expect(screen.getByTestId('manager-children-cap')).toHaveAccessibleDescription(/whole number between 1 and 64/);
    });
  });

  describe('focus after a failed submit', () => {
    it('user is taken to the directory when it is the first invalid field', async () => {
      await renderForm(fakeApi());

      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(screen.getByTestId('new-session-directory')).toHaveFocus();
    });

    it('user is taken to the name when only the name is invalid', async () => {
      await renderForm(fakeApi());
      await userEvent.type(screen.getByTestId('new-session-directory'), '/tmp/wt');

      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(screen.getByTestId('new-session-name')).toHaveFocus();
    });

    it('user is taken to the mission when it is the only invalid field of a manager', async () => {
      await renderForm(fakeApi(), { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });

      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(screen.getByTestId('manager-mission')).toHaveFocus();
    });

    it('user is taken to the pulse seconds before the mission when both are invalid', async () => {
      await renderForm(fakeApi(), { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });
      await setNumberField('manager-pulse-seconds', '0');

      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(screen.getByTestId('manager-pulse-seconds')).toHaveFocus();
    });
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

    it.each([
      ['pulse seconds lower bound', 'manager-pulse-seconds', '1', 'pulseSeconds', 1],
      ['pulse seconds upper bound', 'manager-pulse-seconds', '86400', 'pulseSeconds', 86_400],
      ['children cap lower bound', 'manager-children-cap', '1', 'childrenCap', 1],
      ['children cap upper bound', 'manager-children-cap', '64', 'childrenCap', 64],
    ])('user can create a manager at the %s', async (_label, testId, typed, field, expected) => {
      const api = fakeApi();
      await renderManagerFormWithMinimalValidFields(api);

      await setNumberField(testId, typed);
      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(api.createManagerSession).toHaveBeenCalledWith(expect.objectContaining({ [field]: expected }));
    });

    it.each([
      ['pulse seconds left empty', 'manager-pulse-seconds', ''],
      ['a fractional pulse seconds', 'manager-pulse-seconds', '1.5'],
      ['children cap left empty', 'manager-children-cap', ''],
      ['a fractional children cap', 'manager-children-cap', '2.5'],
    ])('user cannot submit %s and sees why', async (_label, testId, typed) => {
      const api = fakeApi();
      await renderManagerFormWithMinimalValidFields(api);

      await setNumberField(testId, typed);
      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(screen.getByTestId(`${testId}-error`)).toHaveTextContent('whole number');
      expect(api.createManagerSession).not.toHaveBeenCalled();
    });

    it('user typing only spaces as the mission is told a manager needs one', async () => {
      const api = fakeApi();
      await renderForm(api, { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });
      await pasteMission('   \n  ');

      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(screen.getByTestId('manager-mission-error')).toHaveTextContent('needs a mission');
      expect(api.createManagerSession).not.toHaveBeenCalled();
    });

    it('user cannot submit a mission whose UTF-8 size exceeds the limit even though it has fewer characters', async () => {
      const api = fakeApi();
      await renderForm(api, { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });
      const threeByteCharacter = '€';
      await pasteMission(threeByteCharacter.repeat(MISSION_MAX_BYTES / 3 + 1));

      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(screen.getByTestId('manager-mission-error')).toHaveTextContent('at most');
      expect(api.createManagerSession).not.toHaveBeenCalled();
    });

    it('user can submit a mission of exactly the size limit', async () => {
      const api = fakeApi();
      await renderForm(api, { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });
      await pasteMission('a'.repeat(MISSION_MAX_BYTES));

      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(api.createManagerSession).toHaveBeenCalledTimes(1);
    });
  });
});
