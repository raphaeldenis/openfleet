import { fireEvent, render, screen, waitFor, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { NgForm } from '@angular/forms';
import { By } from '@angular/platform-browser';
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

  it('user can only pick Claude Code as harness, the others are shown as not available yet', async () => {
    await renderForm(fakeApi());

    const harnessOptions = Array.from(screen.getByTestId('new-session-harness').querySelectorAll('option'));
    const enabledLabels = harnessOptions.filter((option) => !option.disabled).map((option) => option.value);
    const disabledOptions = harnessOptions.filter((option) => option.disabled);

    expect(enabledLabels).toEqual(['claude-cli']);
    expect(disabledOptions.length).toBe(3);
    disabledOptions.forEach((option) => expect(option).toHaveAttribute('title', 'not available yet'));
  });

  describe('permission mode', () => {
    const permissionModeRadio = (name: string) => screen.getByRole('radio', { name });

    it('user is offered the inherited default and every permission mode as a radio, inherited being selected', async () => {
      await renderForm(fakeApi());

      const offeredRadios = within(screen.getByRole('radiogroup', { name: /permission mode/i })).getAllByRole('radio');

      expect(offeredRadios.length).toBe(7);
      expect(permissionModeRadio('inherited')).toBeChecked();
      ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'].forEach((mode) => expect(permissionModeRadio(mode)).not.toBeChecked());
    });

    it('user sees what each permission mode does next to its name', async () => {
      await renderForm(fakeApi());

      expect(permissionModeRadio('inherited')).toHaveAccessibleDescription(/the CLI uses your own default/);
      expect(permissionModeRadio('acceptEdits')).toHaveAccessibleDescription(/File edits run without asking/);
    });

    it('user can create a session with a chosen permission mode', async () => {
      const api = fakeApi();
      await renderForm(api);

      await fillSessionFields();
      await userEvent.click(permissionModeRadio('acceptEdits'));
      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'acceptEdits' }));
    });

    it('user picking bypassPermissions is warned and can only select it by confirming', async () => {
      const api = fakeApi();
      await renderForm(api);
      await fillSessionFields();

      await userEvent.click(permissionModeRadio('bypassPermissions'));
      expect(screen.getByRole('alert')).toHaveTextContent('Everything runs');
      await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(screen.queryByRole('alert')).toBeNull();
      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'bypassPermissions' }));
    });

    it('user cancelling the bypassPermissions warning keeps the mode that was selected before', async () => {
      const api = fakeApi();
      await renderForm(api);
      await fillSessionFields();
      await userEvent.click(permissionModeRadio('plan'));

      await userEvent.click(permissionModeRadio('bypassPermissions'));
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(screen.queryByRole('alert')).toBeNull();
      expect(permissionModeRadio('plan')).toBeChecked();
      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'plan' }));
    });
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

  it.each([
    ['invalid_body', 400, 'rejected these values'],
    ['internal', 500, 'internal error'],
    ['daemon_shutting_down', 503, 'shutting down'],
  ])('user reads what went wrong in words when the backend rejects the create with %s', async (code, status, readableFragment) => {
    const api = fakeApi({ createSession: vi.fn().mockRejectedValue(new ApiError(status, `POST /api/sessions → ${status}`, code)) });
    const { navigateSpy } = await renderForm(api);

    await fillSessionFields();
    await userEvent.click(screen.getByTestId('new-session-submit'));

    const errorLine = screen.getByTestId('new-session-form-error');
    expect(errorLine).toHaveTextContent(readableFragment);
    expect(errorLine).not.toHaveTextContent('/api/sessions');
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('user sees the HTTP status without the request line when the backend rejects the create with an unknown code', async () => {
    const api = fakeApi({ createSession: vi.fn().mockRejectedValue(new ApiError(502, 'POST /api/sessions → 502')) });
    await renderForm(api);

    await fillSessionFields();
    await userEvent.click(screen.getByTestId('new-session-submit'));

    const errorLine = screen.getByTestId('new-session-form-error');
    expect(errorLine).toHaveTextContent('502');
    expect(errorLine).not.toHaveTextContent('/api/sessions');
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

    it.each([
      ['a session is created and the URL then switches to manager mode', {}, { mode: 'manager' }, '/session'],
      ['a manager is created and the URL then switches to session mode', { mode: 'manager' }, {}, '/manager'],
    ])('user is taken to the kind that was submitted when %s during the request', async (_label, initialQueryParams, switchedQueryParams, expectedRoot) => {
      let resolveCreate!: (session: { id: string }) => void;
      const pendingCreate = vi.fn(() => new Promise((resolve) => { resolveCreate = resolve; }));
      const api = fakeApi({ createSession: pendingCreate, createManagerSession: pendingCreate });
      const { navigateSpy, changeUrlQueryParams } = await renderForm(api, initialQueryParams);
      await fillSessionFields({ name: 'Lead' });
      if ('mode' in initialQueryParams) await fillManagerMission();
      await userEvent.click(screen.getByTestId('new-session-submit'));

      changeUrlQueryParams(switchedQueryParams);
      resolveCreate({ id: 'created' });
      await new Promise((resolve) => setTimeout(resolve));

      expect(navigateSpy).toHaveBeenCalledWith([expectedRoot, 'created']);
    });

    it('user cannot edit any field or switch the kind while the create is pending', async () => {
      let resolveCreate!: (session: { id: string }) => void;
      const api = fakeApi({ createManagerSession: vi.fn(() => new Promise((resolve) => { resolveCreate = resolve; })) });
      await renderForm(api, { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });
      await fillManagerMission();

      await userEvent.click(screen.getByTestId('new-session-submit'));

      const lockedTestIds = [
        'new-session-directory', 'new-session-name', 'new-session-emoji', 'new-session-harness', 'new-session-model',
        'manager-pulse-seconds', 'manager-children-cap', 'manager-mission',
        'new-session-mode-session', 'new-session-mode-manager',
      ];
      lockedTestIds.forEach((testId) => expect(screen.getByTestId(testId)).toBeDisabled());
      screen.getAllByRole('radio').forEach((radio) => expect(radio).toBeDisabled());
      resolveCreate({ id: 'm-new' });
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

    it('user whose session was created but could not be opened is told so, and retrying opens it without creating another', async () => {
      const api = fakeApi();
      const { navigateSpy } = await renderForm(api);
      navigateSpy.mockRejectedValueOnce(new Error('navigation failed'));
      await fillSessionFields();

      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(screen.getByTestId('new-session-form-error')).toHaveTextContent('was created');
      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(api.createSession).toHaveBeenCalledTimes(1);
      expect(navigateSpy).toHaveBeenLastCalledWith(['/session', 's-new']);
      expect(screen.queryByTestId('new-session-form-error')).toBeNull();
    });
  });

  describe('while the create is pending', () => {
    function rejectableCreate() {
      let rejectCreate!: (error: unknown) => void;
      const createSession = vi.fn(() => new Promise((_resolve, reject) => { rejectCreate = reject; }));
      return { createSession, rejectCreate: (error: unknown) => rejectCreate(error) };
    }

    it('user pressing Enter in the name field gets focus back on the create button once the create fails', async () => {
      const { createSession, rejectCreate } = rejectableCreate();
      await renderForm(fakeApi({ createSession }));
      await userEvent.type(screen.getByTestId('new-session-directory'), '/tmp/wt');
      await userEvent.type(screen.getByTestId('new-session-name'), 'Gimli{enter}');

      rejectCreate(new ApiError(500, 'POST /api/sessions → 500', 'internal'));

      await waitFor(() => expect(screen.getByTestId('new-session-submit')).toHaveFocus());
    });

    it('user who moved focus to Cancel while the create was pending keeps it there once the create fails', async () => {
      const { createSession, rejectCreate } = rejectableCreate();
      await renderForm(fakeApi({ createSession }));
      await fillSessionFields();
      await userEvent.click(screen.getByTestId('new-session-submit'));
      screen.getByTestId('new-session-cancel').focus();

      rejectCreate(new ApiError(500, 'POST /api/sessions → 500', 'internal'));

      await waitFor(() => expect(screen.getByTestId('new-session-submit')).toBeEnabled());
      expect(screen.getByTestId('new-session-cancel')).toHaveFocus();
    });

    it('user following a "New manager" link keeps the session form until the create settles, then sees the manager form', async () => {
      const { createSession, rejectCreate } = rejectableCreate();
      const { changeUrlQueryParams } = await renderForm(fakeApi({ createSession }));
      await fillSessionFields();
      await userEvent.click(screen.getByTestId('new-session-submit'));

      changeUrlQueryParams({ mode: 'manager' });

      await new Promise((resolve) => setTimeout(resolve));
      expect(screen.getByRole('heading', { name: 'New session' })).toBeTruthy();
      expect(screen.queryByTestId('manager-mission')).toBeNull();

      rejectCreate(new ApiError(500, 'POST /api/sessions → 500', 'internal'));

      await waitFor(() => expect(screen.getByTestId('manager-mission')).toBeTruthy());
      expect(screen.getByRole('heading', { name: 'New manager' })).toBeTruthy();
    });
  });

  describe('toggling between session and manager', () => {
    it.each([
      ['pulse seconds', 'manager-pulse-seconds', '0'],
      ['children cap', 'manager-children-cap', '65'],
    ])('user toggling to session and back still sees the %s error of the value left in the field', async (_label, testId, invalidValue) => {
      await renderForm(fakeApi(), { mode: 'manager' });
      await setNumberField(testId, invalidValue);
      expect(screen.getByTestId(`${testId}-error`)).toBeTruthy();

      await userEvent.click(screen.getByTestId('new-session-mode-session'));
      await userEvent.click(screen.getByTestId('new-session-mode-manager'));

      await waitFor(() => expect(screen.getByTestId(`${testId}-error`)).toBeTruthy());
    });

    it('user toggling to manager and back keeps every typed value', async () => {
      await renderForm(fakeApi());
      await fillSessionFields();
      await userEvent.selectOptions(screen.getByTestId('new-session-model'), 'opus');
      await userEvent.click(screen.getByRole('radio', { name: 'plan' }));
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
      expect(screen.getByRole('radio', { name: 'plan' })).toBeChecked();
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
      await userEvent.click(screen.getByRole('radio', { name: 'plan' }));

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
    it.each([
      ['textbox', /directory/i],
      ['textbox', /name/i],
      ['textbox', /emoji/i],
      ['combobox', /harness/i],
      ['combobox', /model/i],
      ['radiogroup', /permission mode/i],
      ['spinbutton', /pulse seconds/i],
      ['spinbutton', /children cap/i],
      ['textbox', /mission/i],
    ] as const)('gives the %s named %s an accessible name for screen reader users', async (role, name) => {
      await renderForm(fakeApi(), { mode: 'manager' });

      expect(screen.getByRole(role, { name })).toBeTruthy();
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

    it.each([
      ['directory', {}, 'new-session-directory', 'new-session-directory-error'],
      ['mission', { mode: 'manager' }, 'manager-mission', 'manager-mission-error'],
    ])('user is taken to the %s only once it is rendered as invalid and described by its error', async (_label, queryParams, fieldTestId, errorTestId) => {
      await renderForm(fakeApi(), queryParams);
      const field = screen.getByTestId(fieldTestId);
      if ('mode' in queryParams) await fillSessionFields({ name: 'Lead' });
      let attributesWhenFocused: { ariaInvalid: string | null; ariaDescribedBy: string | null } | undefined;
      field.addEventListener('focus', () => {
        attributesWhenFocused = { ariaInvalid: field.getAttribute('aria-invalid'), ariaDescribedBy: field.getAttribute('aria-describedby') };
      });

      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(attributesWhenFocused).toEqual({ ariaInvalid: 'true', ariaDescribedBy: errorTestId });
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

    it('user sees the pulse-seconds error as soon as an out-of-range value is typed, and it clears once corrected', async () => {
      await renderForm(fakeApi(), { mode: 'manager' });
      const input = screen.getByTestId('manager-pulse-seconds');

      await userEvent.clear(input);
      await userEvent.type(input, '0');
      const error = screen.getByTestId('manager-pulse-seconds-error');
      expect(error).toHaveTextContent('✕');
      expect(error).toHaveAttribute('role', 'alert');
      expect(input).toHaveAttribute('aria-invalid', 'true');

      await userEvent.clear(input);
      await userEvent.type(input, '1800');

      expect(screen.queryByTestId('manager-pulse-seconds-error')).toBeNull();
    });

    it('user sees the mission error clear as soon as a mission is typed', async () => {
      await renderForm(fakeApi(), { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });
      await userEvent.click(screen.getByTestId('new-session-submit'));
      expect(screen.getByTestId('manager-mission-error')).toBeTruthy();

      await fillManagerMission('S');

      expect(screen.queryByTestId('manager-mission-error')).toBeNull();
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

  describe('emoji default', () => {
    it('follows the mode while the user has not typed an emoji', async () => {
      await renderForm(fakeApi());
      expect(screen.getByTestId('new-session-emoji')).toHaveValue('🤖');

      await userEvent.click(screen.getByTestId('new-session-mode-manager'));
      expect(screen.getByTestId('new-session-emoji')).toHaveValue('🧭');

      await userEvent.click(screen.getByTestId('new-session-mode-session'));
      expect(screen.getByTestId('new-session-emoji')).toHaveValue('🤖');
    });

    it.each([
      ['left empty', ''],
      ['left as spaces', '   '],
    ])('creates a session with the default emoji when the emoji is %s', async (_label, typedEmoji) => {
      const api = fakeApi();
      await renderForm(api);
      await fillSessionFields();
      await userEvent.clear(screen.getByTestId('new-session-emoji'));
      if (typedEmoji) await userEvent.type(screen.getByTestId('new-session-emoji'), typedEmoji);

      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ emoji: '🤖' }));
    });

    it('creates a manager with the manager default emoji when the emoji is left empty', async () => {
      const api = fakeApi();
      await renderForm(api, { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });
      await fillManagerMission();
      await userEvent.clear(screen.getByTestId('new-session-emoji'));

      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(api.createManagerSession).toHaveBeenCalledWith(expect.objectContaining({ emoji: '🧭' }));
    });

    it('trims the emoji the user typed', async () => {
      const api = fakeApi();
      await renderForm(api);
      await fillSessionFields();
      await userEvent.clear(screen.getByTestId('new-session-emoji'));
      await userEvent.type(screen.getByTestId('new-session-emoji'), ' 🚀 ');

      await userEvent.click(screen.getByTestId('new-session-submit'));

      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ emoji: '🚀' }));
    });

    it('keeps the emoji the user typed when the mode is toggled', async () => {
      const api = fakeApi();
      await renderForm(api);
      await userEvent.clear(screen.getByTestId('new-session-emoji'));
      await userEvent.type(screen.getByTestId('new-session-emoji'), '🚀');

      await userEvent.click(screen.getByTestId('new-session-mode-manager'));
      await userEvent.click(screen.getByTestId('new-session-mode-session'));
      await userEvent.click(screen.getByTestId('new-session-mode-manager'));

      expect(screen.getByTestId('new-session-emoji')).toHaveValue('🚀');
    });
  });

  it('registers every manager field with the form without Angular reporting NG01354', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fixture } = await renderForm(fakeApi());

    await userEvent.click(screen.getByTestId('new-session-mode-manager'));
    await fixture.whenStable();

    const reportedMessages = consoleWarn.mock.calls.map((callArguments) => String(callArguments[0]));
    expect(reportedMessages.filter((message) => message.includes('NG01354'))).toEqual([]);
    consoleWarn.mockRestore();
    const ngForm = fixture.debugElement.query(By.directive(NgForm)).injector.get(NgForm);
    expect(Object.keys(ngForm.controls)).toEqual(expect.arrayContaining(['pulseSeconds', 'childrenCap', 'mission']));
  });
});
