import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { NewSessionFormComponent } from './new-session-form.component';
import { ApiError, FleetApiService } from '../core/fleet-api.service';

// Hostile black-box tests of the /new form follow-ups (P2-U5b).
// `it.fails` marks a proven defect: the test states the behaviour a user should get and currently
// fails on it. When the defect is fixed the test starts passing, vitest flags the `it.fails`, and the
// marker is dropped.

const MISSION_MAX_BYTES = 64 * 1024;

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

function rejectableCreate() {
  let rejectCreate!: (error: unknown) => void;
  const createSession = vi.fn(() => new Promise((_resolve, reject) => { rejectCreate = reject; }));
  return { createSession, rejectCreate: (error: unknown) => rejectCreate(error) };
}

const radio = (name: string) => screen.getByRole('radio', { name });
const submitButton = () => screen.getByTestId('new-session-submit');
const nextMacrotask = () => new Promise((resolve) => setTimeout(resolve));
const focusModelSelectThenTabIntoPermissionModes = async () => {
  screen.getByTestId('new-session-model').focus();
  await userEvent.tab();
};

async function fillSessionFields({ directory = '/tmp/wt', name = 'Gimli' } = {}): Promise<void> {
  await userEvent.type(screen.getByTestId('new-session-directory'), directory);
  await userEvent.type(screen.getByTestId('new-session-name'), name);
}

async function fillManagerMission(mission = 'Ship phase 2'): Promise<void> {
  await userEvent.type(screen.getByTestId('manager-mission'), mission);
}

async function pasteMission(mission: string): Promise<void> {
  await userEvent.click(screen.getByTestId('manager-mission'));
  await userEvent.paste(mission);
}

describe('NewSessionFormComponent — hostile QE pass (P2-U5b)', () => {
  describe('permission mode radiogroup, keyboard', () => {
    it('Tab enters the group once, at the checked radio, and leaves it on the next Tab', async () => {
      await renderForm(fakeApi());

      await focusModelSelectThenTabIntoPermissionModes();
      expect(radio('inherited')).toHaveFocus();

      await userEvent.click(radio('plan'));
      await focusModelSelectThenTabIntoPermissionModes();
      expect(radio('plan')).toHaveFocus();

      await userEvent.tab();
      expect(screen.getByTestId('new-session-emoji')).toHaveFocus();
    });

    it('arrow keys move the focus and select the mode, and the selected mode is what gets created', async () => {
      const api = fakeApi();
      await renderForm(api);
      await fillSessionFields();
      await focusModelSelectThenTabIntoPermissionModes();

      await userEvent.keyboard('{ArrowDown}{ArrowDown}');

      expect(radio('acceptEdits')).toBeChecked();
      expect(radio('acceptEdits')).toHaveFocus();
      expect(radio('inherited')).not.toBeChecked();
      expect(radio('manual')).not.toBeChecked();

      await userEvent.click(submitButton());

      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'acceptEdits' }));
    });

    it('ArrowUp then ArrowDown comes back to the mode the user started from', async () => {
      const api = fakeApi();
      await renderForm(api);
      await fillSessionFields();
      await userEvent.click(radio('plan'));

      await userEvent.keyboard('{ArrowUp}');
      expect(radio('acceptEdits')).toBeChecked();
      await userEvent.keyboard('{ArrowDown}');

      expect(radio('plan')).toBeChecked();
      await userEvent.click(submitButton());
      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'plan' }));
    });

    it.each([
      ['inherited', /the CLI uses your own default/],
      ['manual', /asks before risky tools/],
      ['acceptEdits', /File edits run without asking/],
      ['plan', /Read-only/],
      ['auto', /project allow-list/],
      ['dontAsk', /denied instead of asked/],
      ['bypassPermissions', /Everything runs/],
    ])('the %s radio is named by its label only and announces its own description', async (mode, description) => {
      await renderForm(fakeApi());

      expect(radio(mode)).toHaveAccessibleName(mode);
      expect(radio(mode)).toHaveAccessibleDescription(description);
    });

    it('the mode chosen stays checked after the create fails and is sent again on the retry', async () => {
      const createSession = vi.fn().mockRejectedValueOnce(new ApiError(500, 'boom', 'internal')).mockResolvedValueOnce({ id: 's-new' });
      await renderForm(fakeApi({ createSession }));
      await fillSessionFields();
      await userEvent.click(radio('dontAsk'));

      await userEvent.click(submitButton());
      expect(radio('dontAsk')).toBeChecked();
      await userEvent.click(submitButton());

      expect(createSession).toHaveBeenLastCalledWith(expect.objectContaining({ permissionMode: 'dontAsk' }));
    });
  });

  describe('bypassPermissions confirmation', () => {
    it('a keyboard-only user can reach bypassPermissions, tab to Confirm, and confirm it', async () => {
      const api = fakeApi();
      await renderForm(api);
      await fillSessionFields();
      await focusModelSelectThenTabIntoPermissionModes();

      await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');
      expect(radio('bypassPermissions')).toBeChecked();
      expect(screen.getByRole('alert')).toHaveTextContent('Everything runs');
      await userEvent.tab();
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
      await userEvent.tab();
      expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus();
      await userEvent.keyboard('{Enter}');

      expect(screen.queryByRole('alert')).toBeNull();
      expect(radio('bypassPermissions')).toBeChecked();
      expect(api.createSession).not.toHaveBeenCalled();
      await userEvent.click(submitButton());
      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'bypassPermissions' }));
    });

    it('pressing Enter on Cancel or Confirm answers the warning without submitting the form', async () => {
      const api = fakeApi();
      await renderForm(api);
      await fillSessionFields();
      await userEvent.click(radio('plan'));
      await userEvent.click(radio('bypassPermissions'));

      screen.getByRole('button', { name: 'Cancel' }).focus();
      await userEvent.keyboard('{Enter}');

      expect(screen.queryByRole('alert')).toBeNull();
      expect(radio('plan')).toBeChecked();
      expect(api.createSession).not.toHaveBeenCalled();
    });

    it('arrowing away from the pending bypassPermissions choice dismisses the warning and selects the arrowed-to mode', async () => {
      const api = fakeApi();
      await renderForm(api);
      await fillSessionFields();
      await userEvent.click(radio('auto'));
      await userEvent.click(radio('bypassPermissions'));
      expect(screen.getByRole('alert')).toBeTruthy();

      await userEvent.keyboard('{ArrowUp}');

      expect(screen.queryByRole('alert')).toBeNull();
      expect(radio('auto')).toBeChecked();
      await userEvent.click(submitButton());
      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'auto' }));
    });

    it('switching between session and manager while the warning is open keeps the warning and the confirmation applies to the manager', async () => {
      const api = fakeApi();
      await renderForm(api);
      await fillSessionFields({ name: 'Lead' });
      await userEvent.click(radio('bypassPermissions'));

      await userEvent.click(screen.getByTestId('new-session-mode-manager'));
      await fillManagerMission();

      expect(screen.getByRole('alert')).toHaveTextContent('Everything runs');
      expect(radio('bypassPermissions')).toBeChecked();
      await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      await userEvent.click(submitButton());
      expect(api.createManagerSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'bypassPermissions' }));
    });

    // MAJOR — permission-mode-list.component.ts:69 (shownValue) + new-session-form.component.ts:229.
    // While the warning is open the radio shows bypassPermissions but Create sends the previous mode:
    // the user believes the session runs without any permission gate and gets one that prompts, with
    // no word about it. The form should hold the submit until the warning is answered.
    it.fails('DEFECT: Create pressed while the bypass warning is open does not create a session with a mode other than the one shown', async () => {
      const api = fakeApi();
      await renderForm(api);
      await fillSessionFields();
      await userEvent.click(radio('plan'));
      await userEvent.click(radio('bypassPermissions'));
      expect(radio('bypassPermissions')).toBeChecked();

      await userEvent.click(submitButton());

      expect(api.createSession).not.toHaveBeenCalled();
    });

    // MAJOR — same root cause through the keyboard: Enter on the focused bypassPermissions radio
    // submits the form (implicit submission) with the previous mode.
    it.fails('DEFECT: Enter on the bypassPermissions radio while its warning is open does not create a session', async () => {
      const api = fakeApi();
      await renderForm(api);
      await fillSessionFields();
      await userEvent.click(radio('bypassPermissions'));

      await userEvent.keyboard('{Enter}');

      expect(api.createSession).not.toHaveBeenCalled();
    });

    it('control: Enter on a radio submits the form (the DEFECT above is reachable through the keyboard)', async () => {
      const api = fakeApi();
      await renderForm(api);
      await fillSessionFields();
      await userEvent.click(radio('plan'));

      await userEvent.keyboard('{Enter}');

      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'plan' }));
    });

    // MINOR — permission-mode-list.component.ts:41-47: nothing handles Escape, so a keyboard user with
    // the warning open has to Tab to Cancel; Escape does nothing.
    it.fails('DEFECT: Escape dismisses the bypass warning and restores the previous mode', async () => {
      await renderForm(fakeApi());
      await userEvent.click(radio('plan'));
      await userEvent.click(radio('bypassPermissions'));

      await userEvent.keyboard('{Escape}');

      expect(screen.queryByRole('alert')).toBeNull();
      expect(radio('plan')).toBeChecked();
    });

    // MINOR (a11y) — permission-mode-list.component.ts:41-47: the Cancel/Confirm buttons are removed
    // while focused, so focus drops to <body> and a keyboard user restarts from the top of the page.
    it.fails('DEFECT: focus returns to the radio group after Cancel', async () => {
      await renderForm(fakeApi());
      await userEvent.click(radio('plan'));
      await userEvent.click(radio('bypassPermissions'));
      await userEvent.tab();
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

      await userEvent.keyboard('{Enter}');

      expect(radio('plan')).toHaveFocus();
    });

    it.fails('DEFECT: focus returns to the radio group after Confirm', async () => {
      await renderForm(fakeApi());
      await userEvent.click(radio('bypassPermissions'));
      await userEvent.tab();
      await userEvent.tab();
      expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus();

      await userEvent.keyboard('{Enter}');

      expect(radio('bypassPermissions')).toHaveFocus();
    });
  });

  describe('a session that was created but could not be opened', () => {
    async function renderFormWhoseFirstNavigationFails(api = fakeApi()) {
      const rendered = await renderForm(api);
      rendered.navigateSpy.mockRejectedValueOnce(new Error('navigation failed'));
      await fillSessionFields();
      await userEvent.click(submitButton());
      expect(screen.getByTestId('new-session-form-error')).toHaveTextContent('was created');
      return rendered;
    }

    // MAJOR — new-session-form.component.ts:183-191: `createdSession` outlives the toggle. The button
    // says "Create manager", the user filled a mission, and the click opens the earlier *session*
    // (/session/s-new) instead — the manager is never created and the mission is silently dropped.
    it.fails('DEFECT: switching to manager after the failed open and pressing "Create manager" creates the manager', async () => {
      const api = fakeApi();
      const { navigateSpy } = await renderFormWhoseFirstNavigationFails(api);

      await userEvent.click(screen.getByTestId('new-session-mode-manager'));
      await fillManagerMission();
      expect(submitButton()).toHaveTextContent('Create manager');
      await userEvent.click(submitButton());

      expect(api.createManagerSession).toHaveBeenCalledTimes(1);
      expect(navigateSpy).not.toHaveBeenLastCalledWith(['/session', 's-new']);
    });

    it('keeps saying so, and never creates a second session, while every retry of the open fails', async () => {
      const api = fakeApi();
      const { navigateSpy } = await renderFormWhoseFirstNavigationFails(api);
      navigateSpy.mockRejectedValueOnce(new Error('navigation failed again'));

      await userEvent.click(submitButton());

      expect(screen.getByTestId('new-session-form-error')).toHaveTextContent('was created');
      expect(api.createSession).toHaveBeenCalledTimes(1);
      await userEvent.click(submitButton());
      expect(api.createSession).toHaveBeenCalledTimes(1);
      expect(navigateSpy).toHaveBeenLastCalledWith(['/session', 's-new']);
      expect(screen.queryByTestId('new-session-form-error')).toBeNull();
    });

    it('leaving the form and coming back starts clean: the next create really creates', async () => {
      const api = fakeApi();
      const { fixture, navigateSpy } = await renderFormWhoseFirstNavigationFails(api);

      fixture.destroy();
      TestBed.createComponent(NewSessionFormComponent);
      await fillSessionFields({ name: 'Second' });
      await userEvent.click(submitButton());

      expect(api.createSession).toHaveBeenCalledTimes(2);
      expect(api.createSession).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Second' }));
      expect(navigateSpy).toHaveBeenCalledWith(['/session', 's-new']);
    });
  });

  describe('readable create errors', () => {
    it.each([
      ['a string', 'boom'],
      ['null', null],
      ['undefined', undefined],
      ['a plain Error', new Error('Unexpected token < in JSON')],
    ])('shows the connection hint and none of the raw failure when the create rejects with %s', async (_label, rejection) => {
      await renderForm(fakeApi({ createSession: vi.fn().mockRejectedValue(rejection) }));
      await fillSessionFields();

      await userEvent.click(submitButton());

      const errorLine = screen.getByTestId('new-session-form-error');
      expect(errorLine).toHaveTextContent('check your connection');
      expect(errorLine).not.toHaveTextContent(/undefined|null|Unexpected token/);
    });

    it.each([
      ['an empty code', new ApiError(500, 'POST /api/sessions → 500', '')],
      ['a code the app does not know', new ApiError(418, 'POST /api/sessions → 418', 'teapot')],
    ])('falls back to the HTTP status, without the request line, for %s', async (_label, error) => {
      await renderForm(fakeApi({ createSession: vi.fn().mockRejectedValue(error) }));
      await fillSessionFields();

      await userEvent.click(submitButton());

      const errorLine = screen.getByTestId('new-session-form-error');
      expect(errorLine).toHaveTextContent(String(error.status));
      expect(errorLine).not.toHaveTextContent('/api/sessions');
    });

    it('tells the user to check the admin token when the daemon answers unauthorized', async () => {
      await renderForm(fakeApi({ createSession: vi.fn().mockRejectedValue(new ApiError(401, 'POST /api/sessions → 401', 'unauthorized')) }));
      await fillSessionFields();

      await userEvent.click(submitButton());

      expect(screen.getByTestId('new-session-form-error')).toHaveTextContent('admin token');
    });

    it('tells a manager creator to shorten the mission when the payload is too large', async () => {
      await renderForm(fakeApi({ createManagerSession: vi.fn().mockRejectedValue(new ApiError(413, 'POST /api/sessions → 413', 'payload_too_large')) }), { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });
      await fillManagerMission();

      await userEvent.click(submitButton());

      expect(screen.getByTestId('new-session-form-error')).toHaveTextContent('shorten the mission');
    });

    // MINOR — create-session-error.ts:4,17: the code lookup hits Object.prototype, so a daemon
    // answering { error: "constructor" } prints the source of Object() in the form.
    ['constructor', 'toString', '__proto__'].forEach((prototypeKey) => {
      it.fails(`DEFECT: an error code named "${prototypeKey}" reads as the HTTP status, not as a JavaScript object`, async () => {
        await renderForm(fakeApi({ createSession: vi.fn().mockRejectedValue(new ApiError(500, 'POST /api/sessions → 500', prototypeKey)) }));
        await fillSessionFields();

        await userEvent.click(submitButton());

        const errorLine = screen.getByTestId('new-session-form-error');
        expect(errorLine).not.toHaveTextContent(/native code|\[object Object\]/);
        expect(errorLine).toHaveTextContent('500');
      });
    });

    // MINOR — create-session-error.ts:6: the payload_too_large copy tells a plain-session creator to
    // shorten "the mission", a field the session form does not have.
    it.fails('DEFECT: a plain session creator is not told to shorten a mission when the payload is too large', async () => {
      await renderForm(fakeApi({ createSession: vi.fn().mockRejectedValue(new ApiError(413, 'POST /api/sessions → 413', 'payload_too_large')) }));
      await fillSessionFields();

      await userEvent.click(submitButton());

      expect(screen.getByTestId('new-session-form-error')).not.toHaveTextContent(/mission/i);
    });
  });

  describe('focus with a real Tab order', () => {
    it('a user who Tabs to Cancel while the create is pending keeps the focus there once it fails', async () => {
      const { createSession, rejectCreate } = rejectableCreate();
      await renderForm(fakeApi({ createSession }));
      await fillSessionFields();
      await userEvent.click(submitButton());

      await userEvent.tab();
      expect(screen.getByTestId('new-session-cancel')).toHaveFocus();
      rejectCreate(new ApiError(500, 'POST /api/sessions → 500', 'internal'));

      await waitFor(() => expect(submitButton()).toBeEnabled());
      expect(screen.getByTestId('new-session-cancel')).toHaveFocus();
    });

    it('the focus lands on Create after a failed open of a created session, and Tab from there goes on normally', async () => {
      const { navigateSpy } = await renderForm(fakeApi());
      navigateSpy.mockRejectedValueOnce(new Error('navigation failed'));
      await userEvent.type(screen.getByTestId('new-session-directory'), '/tmp/wt');
      await userEvent.type(screen.getByTestId('new-session-name'), 'Gimli{enter}');

      await waitFor(() => expect(submitButton()).toHaveFocus());
      await userEvent.tab({ shift: true });
      expect(screen.getByTestId('new-session-cancel')).toHaveFocus();
    });
  });

  describe('?mode changes arriving while the create is pending', () => {
    it('the form only follows the URL once the create settles, however many changes arrived, and ends on the last one', async () => {
      const { createSession, rejectCreate } = rejectableCreate();
      const { changeUrlQueryParams } = await renderForm(fakeApi({ createSession }));
      await fillSessionFields();
      await userEvent.click(submitButton());

      changeUrlQueryParams({ mode: 'manager' });
      changeUrlQueryParams({});
      changeUrlQueryParams({ mode: 'manager' });
      await nextMacrotask();

      expect(screen.getByRole('heading', { name: 'New session' })).toBeTruthy();
      expect(screen.queryByTestId('manager-mission')).toBeNull();
      rejectCreate(new ApiError(500, 'boom', 'internal'));

      await waitFor(() => expect(screen.getByRole('heading', { name: 'New manager' })).toBeTruthy());
      expect(screen.getByTestId('manager-mission')).toBeTruthy();
    });

    it('a change that is undone while pending leaves the session form as it was, without a manager flash', async () => {
      const { createSession, rejectCreate } = rejectableCreate();
      const { changeUrlQueryParams } = await renderForm(fakeApi({ createSession }));
      await fillSessionFields();
      await userEvent.click(submitButton());

      changeUrlQueryParams({ mode: 'manager' });
      await nextMacrotask();
      expect(screen.queryByTestId('manager-mission')).toBeNull();
      changeUrlQueryParams({});
      await nextMacrotask();
      rejectCreate(new ApiError(500, 'boom', 'internal'));

      await waitFor(() => expect(submitButton()).toBeEnabled());
      expect(screen.getByRole('heading', { name: 'New session' })).toBeTruthy();
      expect(screen.queryByTestId('manager-mission')).toBeNull();
      expect(submitButton()).toHaveTextContent('Create session');
    });

    it('a ?mode change that arrived while pending is applied after the settle, and the next create is a manager', async () => {
      const { createSession, rejectCreate } = rejectableCreate();
      const api = fakeApi({ createSession });
      const { changeUrlQueryParams } = await renderForm(api);
      await fillSessionFields({ name: 'Lead' });
      await userEvent.click(submitButton());
      changeUrlQueryParams({ mode: 'manager' });
      rejectCreate(new ApiError(500, 'boom', 'internal'));
      await waitFor(() => expect(screen.getByTestId('manager-mission')).toBeTruthy());

      await fillManagerMission();
      await userEvent.click(submitButton());

      expect(api.createManagerSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('manager fields after a round trip through session mode', () => {
    // MINOR — manager-fields.component.ts:82-85: ngOnInit revalidates pulse and cap only, so the
    // mission error (empty after a failed submit) disappears on the round trip while the directory and
    // name errors stay, and the pulse/cap errors are restored.
    it.fails('DEFECT: the "needs a mission" error shown after a failed submit is still shown after toggling to session and back', async () => {
      await renderForm(fakeApi(), { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });
      await userEvent.click(submitButton());
      expect(screen.getByTestId('manager-mission-error')).toBeTruthy();

      await userEvent.click(screen.getByTestId('new-session-mode-session'));
      await userEvent.click(screen.getByTestId('new-session-mode-manager'));

      await waitFor(() => expect(screen.getByTestId('manager-mission-error')).toBeTruthy());
    });

    it.fails('DEFECT: the "at most 65536 bytes" error is still shown after toggling to session and back', async () => {
      await renderForm(fakeApi(), { mode: 'manager' });
      await pasteMission('a'.repeat(MISSION_MAX_BYTES + 1));
      expect(screen.getByTestId('manager-mission-error')).toHaveTextContent('at most');

      await userEvent.click(screen.getByTestId('new-session-mode-session'));
      await userEvent.click(screen.getByTestId('new-session-mode-manager'));

      await waitFor(() => expect(screen.getByTestId('manager-mission-error')).toHaveTextContent('at most'));
    });

    it('a cleared pulse field is still an error after the round trip, and correcting it clears the error', async () => {
      await renderForm(fakeApi(), { mode: 'manager' });
      await userEvent.clear(screen.getByTestId('manager-pulse-seconds'));
      expect(screen.getByTestId('manager-pulse-seconds-error')).toBeTruthy();

      await userEvent.click(screen.getByTestId('new-session-mode-session'));
      await userEvent.click(screen.getByTestId('new-session-mode-manager'));
      await waitFor(() => expect(screen.getByTestId('manager-pulse-seconds-error')).toBeTruthy());
      await userEvent.type(screen.getByTestId('manager-pulse-seconds'), '60');

      expect(screen.queryByTestId('manager-pulse-seconds-error')).toBeNull();
    });
  });

  describe('U5 regressions', () => {
    it('sends exactly the documented defaults for a session and nothing else', async () => {
      const api = fakeApi();
      await renderForm(api);

      await fillSessionFields({ directory: '\t/tmp/wt \n', name: '  Gimli\t' });
      await userEvent.click(submitButton());

      expect(api.createSession.mock.calls[0]![0]).toStrictEqual({
        directory: '/tmp/wt', name: 'Gimli', emoji: '🤖', model: 'sonnet', harness: 'claude-cli',
      });
    });

    it('sends exactly the documented defaults for a manager, with the mission trimmed', async () => {
      const api = fakeApi();
      await renderForm(api, { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });

      await pasteMission('\n  Ship phase 2  \n');
      await userEvent.click(submitButton());

      expect(api.createManagerSession.mock.calls[0]![0]).toStrictEqual({
        directory: '/tmp/wt', name: 'Lead', emoji: '🧭', model: 'sonnet', harness: 'claude-cli',
        pulseSeconds: 1800, childrenCap: 2, mission: 'Ship phase 2',
      });
    });

    it.each([
      ['a session', 'haiku'], ['a session', 'sonnet'], ['a session', 'opus'], ['a session', 'fable'],
      ['a manager', 'haiku'], ['a manager', 'sonnet'], ['a manager', 'opus'], ['a manager', 'fable'],
    ])('creates %s with the %s model the user picked, verbatim', async (kind, rung) => {
      const api = fakeApi();
      const isManager = kind === 'a manager';
      await renderForm(api, isManager ? { mode: 'manager' } : {});
      await fillSessionFields({ name: 'Lead' });
      if (isManager) await fillManagerMission();

      await userEvent.selectOptions(screen.getByTestId('new-session-model'), rung);
      await userEvent.click(submitButton());

      const createCall = isManager ? api.createManagerSession : api.createSession;
      expect(createCall).toHaveBeenCalledWith(expect.objectContaining({ model: rung }));
    });

    it('a model picked in session mode survives the round trip through manager mode into the manager payload', async () => {
      const api = fakeApi();
      await renderForm(api);
      await userEvent.selectOptions(screen.getByTestId('new-session-model'), 'fable');
      await userEvent.click(screen.getByTestId('new-session-mode-manager'));
      await fillSessionFields({ name: 'Lead' });
      await fillManagerMission();

      await userEvent.click(submitButton());

      expect(api.createManagerSession).toHaveBeenCalledWith(expect.objectContaining({ model: 'fable' }));
    });

    it('an emoji field left as spaces after switching to manager creates the manager with the manager default, not the session one', async () => {
      const api = fakeApi();
      await renderForm(api);
      await userEvent.clear(screen.getByTestId('new-session-emoji'));
      await userEvent.type(screen.getByTestId('new-session-emoji'), '  ');
      await userEvent.click(screen.getByTestId('new-session-mode-manager'));
      await fillSessionFields({ name: 'Lead' });
      await fillManagerMission();

      await userEvent.click(submitButton());

      expect(api.createManagerSession).toHaveBeenCalledWith(expect.objectContaining({ emoji: '🧭' }));
    });

    it('typing an emoji, toggling to manager and back sends the typed emoji, not a default', async () => {
      const api = fakeApi();
      await renderForm(api);
      await userEvent.clear(screen.getByTestId('new-session-emoji'));
      await userEvent.type(screen.getByTestId('new-session-emoji'), '⚔️');
      await userEvent.click(screen.getByTestId('new-session-mode-manager'));
      await userEvent.click(screen.getByTestId('new-session-mode-session'));
      await fillSessionFields();

      await userEvent.click(submitButton());

      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ emoji: '⚔️' }));
    });
  });
});
