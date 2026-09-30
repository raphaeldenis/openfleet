import { render, screen, waitFor, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { BehaviorSubject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { NewSessionFormComponent } from './new-session-form.component';
import { ApiError, FleetApiService } from '../core/fleet-api.service';

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

function pendingCreate() {
  let settle!: { resolve: (session: { id: string }) => void; reject: (error: unknown) => void };
  const create = vi.fn(() => new Promise((resolve, reject) => { settle = { resolve, reject }; }));
  return { create, resolveCreate: (session: { id: string }) => settle.resolve(session), rejectCreate: (error: unknown) => settle.reject(error) };
}

async function renderFormWithPendingCreate(queryParams: Record<string, string> = {}) {
  const { create, resolveCreate, rejectCreate } = pendingCreate();
  const isManager = queryParams['mode'] === 'manager';
  const api = fakeApi(isManager ? { createManagerSession: create } : { createSession: create });
  const rendered = await renderForm(api, queryParams);
  await fillSessionFields();
  if (isManager) await fillManagerMission();
  return { ...rendered, api, create, resolveCreate, rejectCreate };
}

async function renderFormWhoseFirstNavigationFails(api = fakeApi()) {
  const rendered = await renderForm(api);
  rendered.navigateSpy.mockRejectedValueOnce(new Error('navigation failed'));
  await fillSessionFields();
  await userEvent.click(submitButton());
  expect(formError()).toHaveTextContent('was created');
  return rendered;
}

const radio = (name: string) => screen.getByRole('radio', { name });
const submitButton = () => screen.getByTestId('new-session-submit');
const formError = () => screen.queryByTestId('new-session-form-error');
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

async function setNumberField(testId: string, value: string): Promise<void> {
  await userEvent.clear(screen.getByTestId(testId));
  if (value !== '') await userEvent.type(screen.getByTestId(testId), value);
}

describe('NewSessionFormComponent', () => {
  describe('creating a session', () => {
    it('user can create a session by typing a directory and a name', async () => {
      const api = fakeApi();
      await renderForm(api);

      await fillSessionFields();
      await userEvent.clear(screen.getByTestId('new-session-emoji'));
      await userEvent.type(screen.getByTestId('new-session-emoji'), '⚔️');
      await userEvent.selectOptions(screen.getByTestId('new-session-model'), 'opus');
      await userEvent.click(submitButton());

      expect(api.createSession).toHaveBeenCalledWith({
        directory: '/tmp/wt', name: 'Gimli', emoji: '⚔️', model: 'opus', harness: 'claude-cli',
      });
      expect(api.createManagerSession).not.toHaveBeenCalled();
    });

    it('user is taken to the new session once it is created', async () => {
      const { navigateSpy } = await renderForm(fakeApi());

      await fillSessionFields();
      await userEvent.click(submitButton());

      expect(navigateSpy).toHaveBeenCalledWith(['/session', 's-new']);
    });

    it('sends exactly the documented defaults for a session and nothing else', async () => {
      const api = fakeApi();
      await renderForm(api);

      await fillSessionFields({ directory: '\t/tmp/wt \n', name: '  Gimli\t' });
      await userEvent.click(submitButton());

      expect(api.createSession.mock.calls[0]![0]).toStrictEqual({
        directory: '/tmp/wt', name: 'Gimli', emoji: '🤖', model: 'sonnet', harness: 'claude-cli',
      });
    });

    it('user typing stray spaces around the directory and name creates the session with them trimmed', async () => {
      const api = fakeApi();
      await renderForm(api);

      await fillSessionFields({ directory: '  /tmp/wt  ', name: '  Gimli  ' });
      await userEvent.click(submitButton());

      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ directory: '/tmp/wt', name: 'Gimli' }));
    });

    it('user pressing Enter in the name field creates the session once', async () => {
      const api = fakeApi();
      await renderForm(api);
      await userEvent.type(screen.getByTestId('new-session-directory'), '/tmp/wt');

      await userEvent.type(screen.getByTestId('new-session-name'), 'Gimli{enter}');

      expect(api.createSession).toHaveBeenCalledTimes(1);
    });

    it('user pressing Enter twice in a row in the name field creates the session once', async () => {
      const { create, resolveCreate } = pendingCreate();
      await renderForm(fakeApi({ createSession: create }));
      await userEvent.type(screen.getByTestId('new-session-directory'), '/tmp/wt');
      const fastTypist = userEvent.setup({ delay: null });

      await fastTypist.type(screen.getByTestId('new-session-name'), 'Gimli{enter}{enter}');

      expect(create).toHaveBeenCalledTimes(1);
      resolveCreate({ id: 's-new' });
    });

    it('user can cancel and go back to the sessions overview', async () => {
      await renderForm(fakeApi());

      expect(screen.getByTestId('new-session-cancel')).toHaveAttribute('href', '/');
    });

    it('user who left the form before the create resolves is not pulled back to the new session', async () => {
      const { create, resolveCreate } = pendingCreate();
      const { fixture, navigateSpy } = await renderForm(fakeApi({ createSession: create }));
      await fillSessionFields();
      await userEvent.click(submitButton());

      fixture.destroy();
      resolveCreate({ id: 's-late' });
      await nextMacrotask();

      expect(navigateSpy).not.toHaveBeenCalled();
    });
  });

  describe('creating a manager', () => {
    it('user can create a manager, sharing the workspace and identity fields with the session form', async () => {
      const api = fakeApi();
      const { navigateSpy } = await renderForm(api);

      await userEvent.click(screen.getByTestId('new-session-mode-manager'));
      await fillSessionFields({ name: 'Lead' });
      await setNumberField('manager-pulse-seconds', '900');
      await setNumberField('manager-children-cap', '4');
      await fillManagerMission();
      await userEvent.click(submitButton());

      expect(api.createManagerSession).toHaveBeenCalledWith(expect.objectContaining({
        directory: '/tmp/wt', name: 'Lead', pulseSeconds: 900, childrenCap: 4, mission: 'Ship phase 2', harness: 'claude-cli',
      }));
      expect(api.createSession).not.toHaveBeenCalled();
      expect(navigateSpy).toHaveBeenCalledWith(['/manager', 'm-new']);
    });

    it('sends exactly the documented defaults for a manager, with the mission trimmed and no pulse seconds', async () => {
      const api = fakeApi();
      await renderForm(api, { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });

      await pasteMission('\n  Ship phase 2  \n');
      await userEvent.click(submitButton());

      expect(api.createManagerSession.mock.calls[0]![0]).toStrictEqual({
        directory: '/tmp/wt', name: 'Lead', emoji: '🧭', model: 'sonnet', harness: 'claude-cli',
        childrenCap: 2, mission: 'Ship phase 2',
      });
    });

    describe('the heartbeat left to the daemon', () => {
      it('user sees the pulse field empty and told the daemon decides, instead of a number the form made up', async () => {
        await renderForm(fakeApi(), { mode: 'manager' });

        expect(screen.getByTestId('manager-pulse-seconds')).toHaveValue(null);
        expect(screen.getByTestId('manager-pulse-seconds')).toHaveAttribute('placeholder', 'Daemon default');
        expect(screen.queryByTestId('manager-pulse-seconds-error')).toBeNull();
      });

      it('user who never touches the pulse field creates a manager that carries no pulse seconds, so the daemon default applies', async () => {
        const api = fakeApi();
        await renderForm(api, { mode: 'manager' });
        await fillSessionFields({ name: 'Lead' });
        await fillManagerMission();

        await userEvent.click(submitButton());

        expect(api.createManagerSession.mock.calls[0]![0]).not.toHaveProperty('pulseSeconds');
      });

      it('user who types a pulse of 1800 sends it explicitly, even though it equals the usual default', async () => {
        const api = fakeApi();
        await renderForm(api, { mode: 'manager' });
        await fillSessionFields({ name: 'Lead' });
        await fillManagerMission();

        await setNumberField('manager-pulse-seconds', '1800');
        await userEvent.click(submitButton());

        expect(api.createManagerSession).toHaveBeenCalledWith(expect.objectContaining({ pulseSeconds: 1800 }));
      });

      it('user who types a pulse then clears it is told a whole number is needed and cannot submit', async () => {
        const api = fakeApi();
        await renderForm(api, { mode: 'manager' });
        await fillSessionFields({ name: 'Lead' });
        await fillManagerMission();
        await userEvent.type(screen.getByTestId('manager-pulse-seconds'), '5');
        await userEvent.clear(screen.getByTestId('manager-pulse-seconds'));

        await userEvent.click(submitButton());

        expect(screen.getByTestId('manager-pulse-seconds-error')).toHaveTextContent('whole number');
        expect(api.createManagerSession).not.toHaveBeenCalled();
      });

      it('user who toggles to session and back keeps a pulse field that was never touched empty', async () => {
        await renderForm(fakeApi(), { mode: 'manager' });

        await userEvent.click(screen.getByTestId('new-session-mode-session'));
        await userEvent.click(screen.getByTestId('new-session-mode-manager'));

        await waitFor(() => expect(screen.getByTestId('manager-pulse-seconds')).toHaveValue(null));
        expect(screen.queryByTestId('manager-pulse-seconds-error')).toBeNull();
      });
    });

    it('user typing stray spaces around the mission creates the manager with it trimmed', async () => {
      const api = fakeApi();
      await renderForm(api, { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });

      await pasteMission('  Ship phase 2  \n');
      await userEvent.click(submitButton());

      expect(api.createManagerSession).toHaveBeenCalledWith(expect.objectContaining({ mission: 'Ship phase 2' }));
    });

    it('user creating a manager with a chosen permission mode sends the mode and harness along', async () => {
      const api = fakeApi();
      await renderForm(api, { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });
      await fillManagerMission();
      await userEvent.click(radio('plan'));

      await userEvent.click(submitButton());

      expect(api.createManagerSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'plan', harness: 'claude-cli' }));
    });

    it('user leaving the permission mode on inherited creates a manager with no permission mode', async () => {
      const api = fakeApi();
      await renderForm(api, { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });
      await fillManagerMission();

      await userEvent.click(submitButton());

      expect(api.createManagerSession.mock.calls[0]![0]).not.toHaveProperty('permissionMode');
    });

    it.each([
      ['pulse seconds lower bound', 'manager-pulse-seconds', '1', 'pulseSeconds', 1],
      ['pulse seconds upper bound', 'manager-pulse-seconds', '86400', 'pulseSeconds', 86_400],
      ['children cap lower bound', 'manager-children-cap', '1', 'childrenCap', 1],
      ['children cap upper bound', 'manager-children-cap', '64', 'childrenCap', 64],
    ])('user can create a manager at the %s', async (_label, testId, typed, field, expected) => {
      const api = fakeApi();
      await renderForm(api, { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });
      await fillManagerMission();

      await setNumberField(testId, typed);
      await userEvent.click(submitButton());

      expect(api.createManagerSession).toHaveBeenCalledWith(expect.objectContaining({ [field]: expected }));
    });

    it('user can submit a mission of exactly the size limit', async () => {
      const api = fakeApi();
      await renderForm(api, { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });
      await pasteMission('a'.repeat(MISSION_MAX_BYTES));

      await userEvent.click(submitButton());

      expect(api.createManagerSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('switching between session and manager', () => {
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

    it('user with an unknown ?mode= value gets the plain session form', async () => {
      await renderForm(fakeApi(), { mode: 'bogus' });

      expect(screen.queryByTestId('manager-mission')).toBeNull();
      expect(screen.getByTestId('new-session-mode-session')).toHaveAttribute('aria-pressed', 'true');
    });

    it('user switching to manager mode is not shown validation errors, since the toggle does not submit', async () => {
      const api = fakeApi();
      await renderForm(api);

      await userEvent.click(screen.getByTestId('new-session-mode-manager'));

      expect(screen.queryByTestId('new-session-name-error')).toBeNull();
      expect(screen.queryByTestId('new-session-directory-error')).toBeNull();
      expect(api.createManagerSession).not.toHaveBeenCalled();
    });

    it('user toggling to manager and back keeps every typed value', async () => {
      await renderForm(fakeApi());
      await fillSessionFields();
      await userEvent.selectOptions(screen.getByTestId('new-session-model'), 'opus');
      await userEvent.click(radio('plan'));
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
      expect(radio('plan')).toBeChecked();
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

    it('user following a sidebar link while the form is open sees the form follow the URL', async () => {
      const { changeUrlQueryParams } = await renderForm(fakeApi());
      expect(screen.queryByTestId('manager-mission')).toBeNull();

      changeUrlQueryParams({ mode: 'manager' });
      await waitFor(() => expect(screen.getByTestId('manager-mission')).toBeTruthy());
      expect(screen.getByTestId('new-session-mode-manager')).toHaveAttribute('aria-pressed', 'true');

      changeUrlQueryParams({});
      await waitFor(() => expect(screen.queryByTestId('manager-mission')).toBeNull());
    });

    describe('behind the real router', () => {
      async function renderFormBehindRouter(url: string) {
        TestBed.configureTestingModule({
          providers: [provideRouter([{ path: 'new', component: NewSessionFormComponent }]), { provide: FleetApiService, useValue: fakeApi() }],
        });
        await RouterTestingHarness.create(url);
        return TestBed.inject(Router);
      }

      it('user switching to manager puts ?mode=manager in the URL', async () => {
        const router = await renderFormBehindRouter('/new');

        await userEvent.click(screen.getByTestId('new-session-mode-manager'));

        await waitFor(() => expect(router.url).toBe('/new?mode=manager'));
        expect(screen.getByRole('heading', { name: 'New manager' })).toBeTruthy();
      });

      it('user switching back to session removes the mode from the URL', async () => {
        const router = await renderFormBehindRouter('/new?mode=manager');

        await userEvent.click(screen.getByTestId('new-session-mode-session'));

        await waitFor(() => expect(router.url).toBe('/new'));
        expect(screen.getByRole('heading', { name: 'New session' })).toBeTruthy();
      });
    });

    describe('manager field errors after a round trip through session mode', () => {
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

      it('the "needs a mission" error shown after a failed submit is still shown after toggling to session and back', async () => {
        await renderForm(fakeApi(), { mode: 'manager' });
        await fillSessionFields({ name: 'Lead' });
        await userEvent.click(submitButton());
        expect(screen.getByTestId('manager-mission-error')).toBeTruthy();

        await userEvent.click(screen.getByTestId('new-session-mode-session'));
        await userEvent.click(screen.getByTestId('new-session-mode-manager'));

        await waitFor(() => expect(screen.getByTestId('manager-mission-error')).toBeTruthy());
      });

      it('the "at most 65536 bytes" error is still shown after toggling to session and back', async () => {
        await renderForm(fakeApi(), { mode: 'manager' });
        await pasteMission('a'.repeat(MISSION_MAX_BYTES + 1));
        expect(screen.getByTestId('manager-mission-error')).toHaveTextContent('at most');

        await userEvent.click(screen.getByTestId('new-session-mode-session'));
        await userEvent.click(screen.getByTestId('new-session-mode-manager'));

        await waitFor(() => expect(screen.getByTestId('manager-mission-error')).toHaveTextContent('at most'));
      });

      it('a mission typed then cleared still says a manager needs one after the round trip', async () => {
        await renderForm(fakeApi(), { mode: 'manager' });
        await fillManagerMission('S');
        await userEvent.clear(screen.getByTestId('manager-mission'));
        expect(screen.getByTestId('manager-mission-error')).toBeTruthy();

        await userEvent.click(screen.getByTestId('new-session-mode-session'));
        await userEvent.click(screen.getByTestId('new-session-mode-manager'));

        await waitFor(() => expect(screen.getByTestId('manager-mission-error')).toHaveTextContent('needs a mission'));
      });

      it('a fresh manager form shows no mission error, also after a round trip through session mode', async () => {
        await renderForm(fakeApi());

        await userEvent.click(screen.getByTestId('new-session-mode-manager'));
        expect(screen.queryByTestId('manager-mission-error')).toBeNull();
        await userEvent.click(screen.getByTestId('new-session-mode-session'));
        await userEvent.click(screen.getByTestId('new-session-mode-manager'));

        expect(screen.queryByTestId('manager-mission-error')).toBeNull();
      });

      it('a pulse typed then cleared is still an error after the round trip, and correcting it clears the error', async () => {
        await renderForm(fakeApi(), { mode: 'manager' });
        await userEvent.type(screen.getByTestId('manager-pulse-seconds'), '5');
        await userEvent.clear(screen.getByTestId('manager-pulse-seconds'));
        expect(screen.getByTestId('manager-pulse-seconds-error')).toBeTruthy();

        await userEvent.click(screen.getByTestId('new-session-mode-session'));
        await userEvent.click(screen.getByTestId('new-session-mode-manager'));
        await waitFor(() => expect(screen.getByTestId('manager-pulse-seconds-error')).toBeTruthy());
        await userEvent.type(screen.getByTestId('manager-pulse-seconds'), '60');

        expect(screen.queryByTestId('manager-pulse-seconds-error')).toBeNull();
      });
    });
  });

  describe('validation', () => {
    it('user sees an inline error on the name and directory instead of a submit when both are empty', async () => {
      const api = fakeApi();
      await renderForm(api);

      await userEvent.click(submitButton());

      expect(screen.getByTestId('new-session-name-error')).toBeTruthy();
      expect(screen.getByTestId('new-session-directory-error')).toBeTruthy();
      expect(screen.getByTestId('new-session-name')).toHaveAttribute('aria-invalid', 'true');
      expect(api.createSession).not.toHaveBeenCalled();
    });

    it('user typing only spaces in the directory and name is told both are required', async () => {
      const api = fakeApi();
      await renderForm(api);

      await fillSessionFields({ directory: '   ', name: '   ' });
      await userEvent.click(submitButton());

      expect(screen.getByTestId('new-session-directory-error')).toBeTruthy();
      expect(screen.getByTestId('new-session-name-error')).toBeTruthy();
      expect(api.createSession).not.toHaveBeenCalled();
    });

    it('user sees the name error clear as soon as a name is typed', async () => {
      await renderForm(fakeApi());
      await userEvent.click(submitButton());

      await userEvent.type(screen.getByTestId('new-session-name'), 'G');

      expect(screen.queryByTestId('new-session-name-error')).toBeNull();
    });

    it('user cannot create a manager without a mission', async () => {
      const api = fakeApi();
      await renderForm(api, { mode: 'manager' });

      await fillSessionFields({ name: 'Lead' });
      await userEvent.click(submitButton());

      expect(screen.getByTestId('manager-mission-error')).toBeTruthy();
      expect(api.createManagerSession).not.toHaveBeenCalled();
    });

    it('user typing only spaces as the mission is told a manager needs one', async () => {
      const api = fakeApi();
      await renderForm(api, { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });
      await pasteMission('   \n  ');

      await userEvent.click(submitButton());

      expect(screen.getByTestId('manager-mission-error')).toHaveTextContent('needs a mission');
      expect(api.createManagerSession).not.toHaveBeenCalled();
    });

    it('user sees the mission error clear as soon as a mission is typed', async () => {
      await renderForm(fakeApi(), { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });
      await userEvent.click(submitButton());
      expect(screen.getByTestId('manager-mission-error')).toBeTruthy();

      await fillManagerMission('S');

      expect(screen.queryByTestId('manager-mission-error')).toBeNull();
    });

    it('user cannot submit a mission whose UTF-8 size exceeds the limit even though it has fewer characters', async () => {
      const api = fakeApi();
      await renderForm(api, { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });
      const threeByteCharacter = '€';
      await pasteMission(threeByteCharacter.repeat(MISSION_MAX_BYTES / 3 + 1));

      await userEvent.click(submitButton());

      expect(screen.getByTestId('manager-mission-error')).toHaveTextContent('at most');
      expect(api.createManagerSession).not.toHaveBeenCalled();
    });

    it.each([
      ['0, below the 1..86400 minimum', 'manager-pulse-seconds', '0'],
      ['86401, above the 1..86400 maximum', 'manager-pulse-seconds', '86401'],
      ['0, below the 1..64 minimum', 'manager-children-cap', '0'],
      ['65, above the 1..64 maximum', 'manager-children-cap', '65'],
    ])('user cannot submit a manager field value of %s', async (_label, testId, value) => {
      const api = fakeApi();
      await renderForm(api, { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });
      await fillManagerMission();

      await setNumberField(testId, value);
      await userEvent.click(submitButton());

      expect(api.createManagerSession).not.toHaveBeenCalled();
    });

    it.each([
      ['a fractional pulse seconds', 'manager-pulse-seconds', '1.5'],
      ['children cap left empty', 'manager-children-cap', ''],
      ['a fractional children cap', 'manager-children-cap', '2.5'],
    ])('user cannot submit %s and sees why', async (_label, testId, typed) => {
      const api = fakeApi();
      await renderForm(api, { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });
      await fillManagerMission();

      await setNumberField(testId, typed);
      await userEvent.click(submitButton());

      expect(screen.getByTestId(`${testId}-error`)).toHaveTextContent('whole number');
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

    describe('focus after a failed submit', () => {
      it('user is taken to the directory when it is the first invalid field', async () => {
        await renderForm(fakeApi());

        await userEvent.click(submitButton());

        expect(screen.getByTestId('new-session-directory')).toHaveFocus();
      });

      it('user is taken to the name when only the name is invalid', async () => {
        await renderForm(fakeApi());
        await userEvent.type(screen.getByTestId('new-session-directory'), '/tmp/wt');

        await userEvent.click(submitButton());

        expect(screen.getByTestId('new-session-name')).toHaveFocus();
      });

      it('user is taken to the mission when it is the only invalid field of a manager', async () => {
        await renderForm(fakeApi(), { mode: 'manager' });
        await fillSessionFields({ name: 'Lead' });

        await userEvent.click(submitButton());

        expect(screen.getByTestId('manager-mission')).toHaveFocus();
      });

      it('user is taken to the pulse seconds before the mission when both are invalid', async () => {
        await renderForm(fakeApi(), { mode: 'manager' });
        await fillSessionFields({ name: 'Lead' });
        await setNumberField('manager-pulse-seconds', '0');

        await userEvent.click(submitButton());

        expect(screen.getByTestId('manager-pulse-seconds')).toHaveFocus();
      });
    });
  });

  describe('harness and model', () => {
    it('user can only pick Claude Code as harness, the others are shown as not available yet', async () => {
      await renderForm(fakeApi());

      const harnessOptions = Array.from(screen.getByTestId('new-session-harness').querySelectorAll('option'));
      const enabledLabels = harnessOptions.filter((option) => !option.disabled).map((option) => option.value);
      const disabledOptions = harnessOptions.filter((option) => option.disabled);

      expect(enabledLabels).toEqual(['claude-cli']);
      expect(disabledOptions.length).toBe(3);
      disabledOptions.forEach((option) => expect(option).toHaveAttribute('title', 'not available yet'));
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
  });

  describe('emoji', () => {
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

      await userEvent.click(submitButton());

      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ emoji: '🤖' }));
    });

    it('creates a manager with the manager default emoji when the emoji is left empty', async () => {
      const api = fakeApi();
      await renderForm(api, { mode: 'manager' });
      await fillSessionFields({ name: 'Lead' });
      await fillManagerMission();
      await userEvent.clear(screen.getByTestId('new-session-emoji'));

      await userEvent.click(submitButton());

      expect(api.createManagerSession).toHaveBeenCalledWith(expect.objectContaining({ emoji: '🧭' }));
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

    it('trims the emoji the user typed', async () => {
      const api = fakeApi();
      await renderForm(api);
      await fillSessionFields();
      await userEvent.clear(screen.getByTestId('new-session-emoji'));
      await userEvent.type(screen.getByTestId('new-session-emoji'), ' 🚀 ');

      await userEvent.click(submitButton());

      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ emoji: '🚀' }));
    });

    it('keeps the emoji the user typed when the mode is toggled', async () => {
      await renderForm(fakeApi());
      await userEvent.clear(screen.getByTestId('new-session-emoji'));
      await userEvent.type(screen.getByTestId('new-session-emoji'), '🚀');

      await userEvent.click(screen.getByTestId('new-session-mode-manager'));
      await userEvent.click(screen.getByTestId('new-session-mode-session'));
      await userEvent.click(screen.getByTestId('new-session-mode-manager'));

      expect(screen.getByTestId('new-session-emoji')).toHaveValue('🚀');
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

  describe('permission mode', () => {
    it('lists inherited first and bypassPermissions last as radios, inherited being selected', async () => {
      await renderForm(fakeApi());

      const listedRadios = within(screen.getByRole('radiogroup', { name: /permission mode/i })).getAllByRole('radio');

      const listedModes = ['inherited', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
      expect(listedRadios.length).toBe(listedModes.length);
      listedModes.forEach((mode, index) => expect(listedRadios[index]).toHaveAccessibleName(mode));
      expect(radio('inherited')).toBeChecked();
      listedModes.slice(1).forEach((mode) => expect(radio(mode)).not.toBeChecked());
    });

    it.each([
      ['inherited', /the CLI uses your own default/],
      ['acceptEdits', /File edits run without asking/],
    ])('the %s radio is named by its label only and announces its own description', async (mode, description) => {
      await renderForm(fakeApi());

      expect(radio(mode)).toHaveAccessibleName(mode);
      expect(radio(mode)).toHaveAccessibleDescription(description);
    });

    it('shows the full description of a mode as a tooltip, since the row shows one ellipsized line', async () => {
      await renderForm(fakeApi());

      const fullDescription = screen.getByText(/File edits run without asking/).textContent!.trim();

      expect(screen.getByTitle(fullDescription)).toBeTruthy();
    });

    it('user can create a session with a chosen permission mode', async () => {
      const api = fakeApi();
      await renderForm(api);

      await fillSessionFields();
      await userEvent.click(radio('acceptEdits'));
      await userEvent.click(submitButton());

      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'acceptEdits' }));
    });

    it('user leaving the permission mode on inherited sends no permission mode', async () => {
      const api = fakeApi();
      await renderForm(api);

      await fillSessionFields();
      await userEvent.click(submitButton());

      expect(api.createSession.mock.calls[0]![0]).not.toHaveProperty('permissionMode');
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

    describe('keyboard', () => {
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
    });

    describe('bypassPermissions confirmation', () => {
      it('a keyboard-only user can reach bypassPermissions, tab to Confirm, and confirm it', async () => {
        const api = fakeApi();
        await renderForm(api);
        await fillSessionFields();
        await focusModelSelectThenTabIntoPermissionModes();

        await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');
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

      it('pressing Enter on Cancel answers the warning without submitting the form', async () => {
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
        expect(radio('dontAsk')).toBeChecked();
        await userEvent.click(submitButton());
        expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'dontAsk' }));
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

      it('Create pressed while the warning is open does not create a session with a mode other than the one shown, and asks for the answer', async () => {
        const api = fakeApi();
        await renderForm(api);
        await fillSessionFields();
        await userEvent.click(radio('plan'));
        await userEvent.click(radio('bypassPermissions'));
        expect(radio('bypassPermissions')).toBeChecked();

        await userEvent.click(submitButton());

        expect(api.createSession).not.toHaveBeenCalled();
        expect(screen.getByTestId('new-session-permission-mode-answer-hint')).toHaveTextContent('Confirm or cancel');
        expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus();
      });

      it('once the warning is confirmed after a held Create, pressing Create sends bypassPermissions', async () => {
        const api = fakeApi();
        await renderForm(api);
        await fillSessionFields();
        await userEvent.click(radio('bypassPermissions'));
        await userEvent.click(submitButton());

        await userEvent.keyboard('{Enter}');
        await userEvent.click(submitButton());

        expect(screen.queryByTestId('new-session-permission-mode-answer-hint')).toBeNull();
        expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'bypassPermissions' }));
      });

      it('Escape dismisses the bypass warning and restores the previous mode', async () => {
        await renderForm(fakeApi());
        await userEvent.click(radio('plan'));
        await userEvent.click(radio('bypassPermissions'));

        await userEvent.keyboard('{Escape}');

        expect(screen.queryByRole('alert')).toBeNull();
        expect(radio('plan')).toBeChecked();
      });

      it('focus returns to the radio group after Cancel', async () => {
        await renderForm(fakeApi());
        await userEvent.click(radio('plan'));
        await userEvent.click(radio('bypassPermissions'));
        await userEvent.tab();
        expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

        await userEvent.keyboard('{Enter}');

        expect(radio('plan')).toHaveFocus();
      });

      it('focus returns to the radio group after Confirm', async () => {
        await renderForm(fakeApi());
        await userEvent.click(radio('bypassPermissions'));
        await userEvent.tab();
        await userEvent.tab();
        expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus();

        await userEvent.keyboard('{Enter}');

        expect(radio('bypassPermissions')).toHaveFocus();
      });
    });
  });

  describe('create errors', () => {
    it.each([
      ['invalid_body', 400, 'rejected these values'],
      ['internal', 500, 'internal error'],
      ['daemon_shutting_down', 503, 'shutting down'],
    ])('user reads what went wrong in words when the backend rejects the create with %s', async (code, status, readableFragment) => {
      const api = fakeApi({ createSession: vi.fn().mockRejectedValue(new ApiError(status, `POST /api/sessions → ${status}`, code)) });
      const { navigateSpy } = await renderForm(api);

      await fillSessionFields();
      await userEvent.click(submitButton());

      const errorLine = screen.getByTestId('new-session-form-error');
      expect(errorLine).toHaveTextContent(readableFragment);
      expect(errorLine).not.toHaveTextContent('/api/sessions');
      expect(navigateSpy).not.toHaveBeenCalled();
    });

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

    it('a plain session creator is not told to shorten a mission when the payload is too large', async () => {
      await renderForm(fakeApi({ createSession: vi.fn().mockRejectedValue(new ApiError(413, 'POST /api/sessions → 413', 'payload_too_large')) }));
      await fillSessionFields();

      await userEvent.click(submitButton());

      expect(screen.getByTestId('new-session-form-error')).not.toHaveTextContent(/mission/i);
    });

    ['constructor', 'toString', '__proto__'].forEach((prototypeKey) => {
      it(`an error code named "${prototypeKey}" reads as the HTTP status, not as a JavaScript object`, async () => {
        await renderForm(fakeApi({ createSession: vi.fn().mockRejectedValue(new ApiError(500, 'POST /api/sessions → 500', prototypeKey)) }));
        await fillSessionFields();

        await userEvent.click(submitButton());

        const errorLine = screen.getByTestId('new-session-form-error');
        expect(errorLine).not.toHaveTextContent(/native code|\[object Object\]/);
        expect(errorLine).toHaveTextContent('500');
      });
    });

    it('user keeps what was typed, can retry and is not navigated away after the backend rejects the create', async () => {
      const createSession = vi.fn().mockRejectedValueOnce(new ApiError(500, 'boom')).mockResolvedValueOnce({ id: 's-new' });
      const { navigateSpy } = await renderForm(fakeApi({ createSession }));
      await fillSessionFields();

      await userEvent.click(submitButton());

      expect(screen.getByTestId('new-session-directory')).toHaveValue('/tmp/wt');
      expect(screen.getByTestId('new-session-name')).toHaveValue('Gimli');
      expect(submitButton()).not.toHaveAttribute('aria-disabled');
      expect(navigateSpy).not.toHaveBeenCalled();

      await userEvent.click(submitButton());

      expect(createSession).toHaveBeenCalledTimes(2);
      expect(formError()).toBeNull();
      expect(navigateSpy).toHaveBeenCalledWith(['/session', 's-new']);
    });

    describe('in the vocabulary of the mode', () => {
      it.each([
        ['a connection failure', new TypeError('Failed to fetch')],
        ['an internal error', new ApiError(500, 'boom', 'internal')],
        ['an unknown error code', new ApiError(418, 'teapot', 'teapot')],
      ])('%s while creating a manager never says "session"', async (_label, rejection) => {
        const createManagerSession = vi.fn().mockRejectedValue(rejection);
        await renderForm(fakeApi({ createManagerSession }), { mode: 'manager' });
        await fillSessionFields({ name: 'Lead' });
        await fillManagerMission();

        await userEvent.click(submitButton());

        expect(formError()).toHaveTextContent(/manager/);
        expect(formError()).not.toHaveTextContent(/session/i);
      });

      it('a manager that was created but not opened is called a manager', async () => {
        const { navigateSpy } = await renderForm(fakeApi(), { mode: 'manager' });
        navigateSpy.mockResolvedValueOnce(false);
        await fillSessionFields({ name: 'Lead' });
        await fillManagerMission();

        await userEvent.click(submitButton());

        expect(formError()).toHaveTextContent('The manager was created but could not be opened');
        expect(formError()).not.toHaveTextContent(/session/i);
      });

      it('a session that was created but not opened is called a session', async () => {
        const { navigateSpy } = await renderForm(fakeApi());
        navigateSpy.mockResolvedValueOnce(false);
        await fillSessionFields();

        await userEvent.click(submitButton());

        expect(formError()).toHaveTextContent('The session was created but could not be opened');
      });
    });

    describe('following the form', () => {
      const rejectingApi = () => fakeApi({ createSession: vi.fn().mockRejectedValue(new ApiError(500, 'boom', 'internal')) });

      it('a create error disappears as soon as the user edits a field', async () => {
        await renderForm(rejectingApi());
        await fillSessionFields();
        await userEvent.click(submitButton());
        expect(formError()).toBeTruthy();

        await userEvent.type(screen.getByTestId('new-session-name'), '!');

        expect(formError()).toBeNull();
      });

      it('a create error disappears when the user switches between session and manager', async () => {
        await renderForm(rejectingApi());
        await fillSessionFields();
        await userEvent.click(submitButton());
        expect(formError()).toBeTruthy();

        await userEvent.click(screen.getByTestId('new-session-mode-manager'));

        expect(formError()).toBeNull();
      });

      it('a create error stays while the form is left as it was', async () => {
        await renderForm(rejectingApi());
        await fillSessionFields();

        await userEvent.click(submitButton());
        await userEvent.tab();

        expect(formError()).toBeTruthy();
      });

      it('the previous create error is cleared while the bypassPermissions warning holds Create', async () => {
        const createSession = vi.fn().mockRejectedValueOnce(new ApiError(500, 'boom', 'internal'));
        await renderForm(fakeApi({ createSession }));
        await fillSessionFields();
        await userEvent.click(submitButton());
        expect(formError()).toBeTruthy();
        await userEvent.click(radio('bypassPermissions'));

        await userEvent.click(submitButton());

        expect(screen.getByTestId('new-session-permission-mode-answer-hint')).toBeTruthy();
        expect(formError()).toBeNull();
      });
    });
  });

  describe('a create that is pending', () => {
    it.each([
      ['session', {}, 'Creating session…'],
      ['manager', { mode: 'manager' }, 'Creating manager…'],
    ])('announces the %s being created through a busy form and a status', async (_kind, queryParams, announcement) => {
      const { resolveCreate } = await renderFormWithPendingCreate(queryParams);
      const form = screen.getByTestId('new-session-form');
      expect(form).not.toHaveAttribute('aria-busy', 'true');

      await userEvent.click(submitButton());

      expect(form).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByRole('status')).toHaveTextContent(announcement);
      resolveCreate({ id: 'created' });
      await waitFor(() => expect(form).not.toHaveAttribute('aria-busy', 'true'));
      expect(screen.getByRole('status')).toBeEmptyDOMElement();
    });

    it('the Create button that was activated with Enter keeps the focus, announces it is busy through aria-disabled, and a second Enter sends no second request', async () => {
      const { create, resolveCreate } = await renderFormWithPendingCreate();
      submitButton().focus();

      await userEvent.keyboard('{Enter}');

      expect(create).toHaveBeenCalledTimes(1);
      expect(submitButton()).toHaveFocus();
      expect(submitButton()).not.toHaveAttribute('disabled');
      expect(submitButton()).toHaveAttribute('aria-disabled', 'true');
      await userEvent.keyboard('{Enter}');
      expect(create).toHaveBeenCalledTimes(1);
      resolveCreate({ id: 's-new' });
    });

    it('Create is a live button again, without aria-disabled, once the create has failed', async () => {
      const createSession = vi.fn().mockRejectedValueOnce(new ApiError(500, 'boom', 'internal')).mockResolvedValueOnce({ id: 's-new' });
      await renderForm(fakeApi({ createSession }));
      await fillSessionFields();

      await userEvent.click(submitButton());

      await waitFor(() => expect(submitButton()).not.toHaveAttribute('aria-disabled'));
      await userEvent.click(submitButton());
      expect(createSession).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['directory', 'new-session-directory'],
      ['name', 'new-session-name'],
    ])('the %s input Enter was pressed in keeps the focus and is not disabled, yet cannot be edited while the create is pending', async (_label, testId) => {
      const { create, resolveCreate } = await renderFormWithPendingCreate();
      const input = screen.getByTestId(testId);
      const valueBeforeSubmit = (input as HTMLInputElement).value;
      input.focus();

      await userEvent.keyboard('{Enter}');

      expect(create).toHaveBeenCalledTimes(1);
      expect(input).toHaveFocus();
      expect(input).toBeEnabled();
      await userEvent.keyboard('more');
      expect(input).toHaveValue(valueBeforeSubmit);
      await userEvent.keyboard('{Enter}');
      expect(create).toHaveBeenCalledTimes(1);
      resolveCreate({ id: 's-new' });
    });

    it('the emoji input cannot be edited while the create is pending and stays enabled', async () => {
      const { resolveCreate } = await renderFormWithPendingCreate();
      await userEvent.click(submitButton());
      const emojiInput = screen.getByTestId('new-session-emoji');

      await userEvent.type(emojiInput, 'x');

      expect(emojiInput).toBeEnabled();
      expect(emojiInput).toHaveValue('🤖');
      resolveCreate({ id: 's-new' });
    });

    it('the model select keeps the value the create was sent with while it is pending', async () => {
      const { resolveCreate } = await renderFormWithPendingCreate();
      await userEvent.click(submitButton());

      await userEvent.selectOptions(screen.getByTestId('new-session-model'), 'opus');

      expect(screen.getByTestId('new-session-model')).toHaveValue('sonnet');
      resolveCreate({ id: 's-new' });
    });

    it('the manager fields cannot be edited while the create is pending and stay enabled', async () => {
      const { resolveCreate } = await renderFormWithPendingCreate({ mode: 'manager' });
      screen.getByTestId('manager-mission').focus();
      await userEvent.click(submitButton());

      await userEvent.type(screen.getByTestId('manager-mission'), ' extra');
      await userEvent.type(screen.getByTestId('manager-pulse-seconds'), '5');
      await userEvent.type(screen.getByTestId('manager-children-cap'), '5');

      expect(screen.getByTestId('manager-mission')).toBeEnabled();
      expect(screen.getByTestId('manager-mission')).toHaveValue('Ship phase 2');
      expect(screen.getByTestId('manager-pulse-seconds')).toHaveValue(null);
      expect(screen.getByTestId('manager-children-cap')).toHaveValue(2);
      resolveCreate({ id: 'm-new' });
    });

    it('the Session and Manager toggles are not disabled while the create is pending, announce it through aria-disabled, and do not switch the kind', async () => {
      const { resolveCreate } = await renderFormWithPendingCreate();
      await userEvent.click(submitButton());

      await userEvent.click(screen.getByTestId('new-session-mode-manager'));

      for (const testId of ['new-session-mode-session', 'new-session-mode-manager']) {
        expect(screen.getByTestId(testId)).not.toHaveAttribute('disabled');
        expect(screen.getByTestId(testId)).toHaveAttribute('aria-disabled', 'true');
      }
      expect(screen.getByRole('heading', { name: 'New session' })).toBeTruthy();
      expect(screen.queryByTestId('manager-mission')).toBeNull();
      resolveCreate({ id: 's-new' });
    });

    it('the permission mode radios keep the focus, are not disabled, announce it through aria-disabled, and neither click nor arrow keys change the mode while the create is pending', async () => {
      const { create, resolveCreate } = await renderFormWithPendingCreate();
      await userEvent.click(radio('plan'));
      radio('plan').focus();

      await userEvent.keyboard('{Enter}');

      expect(create).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'plan' }));
      expect(radio('plan')).toHaveFocus();
      screen.getAllByRole('radio').forEach((each) => {
        expect(each).not.toHaveAttribute('disabled');
        expect(each).toHaveAttribute('aria-disabled', 'true');
      });
      await userEvent.keyboard('{ArrowDown}');
      expect(radio('plan')).toBeChecked();
      expect(radio('plan')).toHaveFocus();
      await userEvent.click(radio('auto'));
      expect(radio('plan')).toBeChecked();
      expect(radio('auto')).not.toBeChecked();
      resolveCreate({ id: 's-new' });
    });

    it('every field is editable again once the create has failed', async () => {
      const createSession = vi.fn().mockRejectedValueOnce(new ApiError(500, 'boom', 'internal'));
      await renderForm(fakeApi({ createSession }));
      await fillSessionFields();
      await userEvent.click(submitButton());
      await waitFor(() => expect(submitButton()).not.toHaveAttribute('aria-disabled'));

      await userEvent.type(screen.getByTestId('new-session-name'), '!');
      await userEvent.click(radio('auto'));
      await userEvent.click(screen.getByTestId('new-session-mode-manager'));

      expect(screen.getByRole('heading', { name: 'New manager' })).toBeTruthy();
      await userEvent.click(screen.getByTestId('new-session-mode-session'));
      expect(screen.getByTestId('new-session-name')).toHaveValue('Gimli!');
      expect(radio('auto')).toBeChecked();
    });

    describe('focus', () => {
      it('a user who Tabs to Cancel while the create is pending keeps the focus there once it fails', async () => {
        const { rejectCreate } = await renderFormWithPendingCreate();
        await userEvent.click(submitButton());

        await userEvent.tab({ shift: true });
        expect(screen.getByTestId('new-session-cancel')).toHaveFocus();
        rejectCreate(new ApiError(500, 'POST /api/sessions → 500', 'internal'));

        await waitFor(() => expect(submitButton()).not.toHaveAttribute('aria-disabled'));
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

    describe('?mode changes arriving meanwhile', () => {
      it('the form only follows the URL once the create settles, however many changes arrived, and ends on the last one', async () => {
        const { rejectCreate, changeUrlQueryParams } = await renderFormWithPendingCreate();
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
        const { rejectCreate, changeUrlQueryParams } = await renderFormWithPendingCreate();
        await userEvent.click(submitButton());

        changeUrlQueryParams({ mode: 'manager' });
        await nextMacrotask();
        expect(screen.queryByTestId('manager-mission')).toBeNull();
        changeUrlQueryParams({});
        await nextMacrotask();
        rejectCreate(new ApiError(500, 'boom', 'internal'));

        await waitFor(() => expect(submitButton()).not.toHaveAttribute('aria-disabled'));
        expect(screen.getByRole('heading', { name: 'New session' })).toBeTruthy();
        expect(screen.queryByTestId('manager-mission')).toBeNull();
        expect(submitButton()).toHaveTextContent('Create session');
      });

      it('a change that arrived while pending is applied after the settle, and the next create is a manager', async () => {
        const { api, rejectCreate, changeUrlQueryParams } = await renderFormWithPendingCreate();
        await userEvent.click(submitButton());
        changeUrlQueryParams({ mode: 'manager' });
        rejectCreate(new ApiError(500, 'boom', 'internal'));
        await waitFor(() => expect(screen.getByTestId('manager-mission')).toBeTruthy());

        await fillManagerMission();
        await userEvent.click(submitButton());

        expect(api.createManagerSession).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['a session is created and the URL then switches to manager mode', {}, { mode: 'manager' }, '/session'],
        ['a manager is created and the URL then switches to session mode', { mode: 'manager' }, {}, '/manager'],
      ])('user is taken to the kind that was submitted when %s during the request', async (_label, initialQueryParams, switchedQueryParams, expectedRoot) => {
        const { create, resolveCreate } = pendingCreate();
        const { navigateSpy, changeUrlQueryParams } = await renderForm(fakeApi({ createSession: create, createManagerSession: create }), initialQueryParams);
        await fillSessionFields({ name: 'Lead' });
        if ('mode' in initialQueryParams) await fillManagerMission();
        await userEvent.click(submitButton());

        changeUrlQueryParams(switchedQueryParams);
        resolveCreate({ id: 'created' });
        await nextMacrotask();

        expect(navigateSpy).toHaveBeenCalledWith([expectedRoot, 'created']);
      });
    });
  });

  describe('a session that was created but could not be opened', () => {
    it('is told so, and retrying opens it without creating another', async () => {
      const api = fakeApi();
      const { navigateSpy } = await renderFormWhoseFirstNavigationFails(api);

      await userEvent.click(submitButton());

      expect(api.createSession).toHaveBeenCalledTimes(1);
      expect(navigateSpy).toHaveBeenLastCalledWith(['/session', 's-new']);
      expect(formError()).toBeNull();
    });

    it('is told so when the navigation resolves false', async () => {
      const { navigateSpy } = await renderForm(fakeApi());
      navigateSpy.mockResolvedValueOnce(false);
      await fillSessionFields();

      await userEvent.click(submitButton());

      expect(formError()).toHaveTextContent('was created');
      await userEvent.click(submitButton());
      expect(navigateSpy).toHaveBeenLastCalledWith(['/session', 's-new']);
      expect(formError()).toBeNull();
    });

    it('keeps saying so, and never creates a second session, while every retry of the open fails', async () => {
      const api = fakeApi();
      const { navigateSpy } = await renderFormWhoseFirstNavigationFails(api);
      navigateSpy.mockRejectedValueOnce(new Error('navigation failed again'));

      await userEvent.click(submitButton());

      expect(formError()).toHaveTextContent('was created');
      expect(api.createSession).toHaveBeenCalledTimes(1);
      await userEvent.click(submitButton());
      expect(api.createSession).toHaveBeenCalledTimes(1);
      expect(navigateSpy).toHaveBeenLastCalledWith(['/session', 's-new']);
      expect(formError()).toBeNull();
    });

    it('is not created twice when the user only adds a space around a field before retrying', async () => {
      const api = fakeApi();
      const { navigateSpy } = await renderFormWhoseFirstNavigationFails(api);

      await userEvent.type(screen.getByTestId('new-session-name'), ' ');
      await userEvent.click(submitButton());

      expect(api.createSession).toHaveBeenCalledTimes(1);
      expect(navigateSpy).toHaveBeenLastCalledWith(['/session', 's-new']);
    });

    it('the line disappears as soon as the user edits a field', async () => {
      await renderFormWhoseFirstNavigationFails();

      await userEvent.type(screen.getByTestId('new-session-name'), '!');

      expect(formError()).toBeNull();
    });

    it('editing a field and pressing Create creates a new session with the edit', async () => {
      const api = fakeApi();
      await renderFormWhoseFirstNavigationFails(api);

      await userEvent.type(screen.getByTestId('new-session-name'), ' the Second');
      await userEvent.click(submitButton());

      expect(api.createSession).toHaveBeenCalledTimes(2);
      expect(api.createSession).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Gimli the Second' }));
    });

    it('switching to manager and pressing "Create manager" creates the manager', async () => {
      const api = fakeApi();
      const { navigateSpy } = await renderFormWhoseFirstNavigationFails(api);

      await userEvent.click(screen.getByTestId('new-session-mode-manager'));
      await fillManagerMission();
      expect(submitButton()).toHaveTextContent('Create manager');
      await userEvent.click(submitButton());

      expect(api.createManagerSession).toHaveBeenCalledTimes(1);
      expect(navigateSpy).not.toHaveBeenLastCalledWith(['/session', 's-new']);
    });

    it('a failed create after a failed open reads as a create failure, not as a session that was created', async () => {
      const createSession = vi.fn().mockResolvedValueOnce({ id: 's-new' }).mockRejectedValueOnce(new ApiError(500, 'boom', 'internal'));
      await renderFormWhoseFirstNavigationFails(fakeApi({ createSession }));

      await userEvent.type(screen.getByTestId('new-session-name'), ' the Second');
      await userEvent.click(submitButton());

      expect(formError()).toHaveTextContent('internal error');
    });

    it('is created again by a form with the same values after the user left and came back', async () => {
      const api = fakeApi();
      const { fixture } = await renderFormWhoseFirstNavigationFails(api);
      fixture.destroy();

      TestBed.createComponent(NewSessionFormComponent);
      await fillSessionFields();
      await userEvent.click(submitButton());

      expect(api.createSession).toHaveBeenCalledTimes(2);
    });

    describe('with a ?mode change that arrived while the create was pending', () => {
      async function renderFormWhoseCreateIsPendingWhenTheUrlSwitchesToManager() {
        const { create, resolveCreate } = pendingCreate();
        const api = fakeApi({ createSession: create });
        const rendered = await renderForm(api);
        rendered.navigateSpy.mockResolvedValueOnce(false);
        await fillSessionFields();
        await userEvent.click(submitButton());
        rendered.changeUrlQueryParams({ mode: 'manager' });
        resolveCreate({ id: 's-new' });
        await nextMacrotask();
        return { ...rendered, api };
      }

      it('keeps the line and the retry, on the session form, until the user acts', async () => {
        const { api, navigateSpy } = await renderFormWhoseCreateIsPendingWhenTheUrlSwitchesToManager();

        expect(formError()).toHaveTextContent('The session was created but could not be opened');
        expect(screen.getByRole('heading', { name: 'New session' })).toBeTruthy();
        await userEvent.click(submitButton());
        expect(api.createSession).toHaveBeenCalledTimes(1);
        expect(navigateSpy).toHaveBeenLastCalledWith(['/session', 's-new']);
      });

      it('applies the change once the user edits the form', async () => {
        await renderFormWhoseCreateIsPendingWhenTheUrlSwitchesToManager();

        await userEvent.type(screen.getByTestId('new-session-name'), '!');

        await waitFor(() => expect(screen.getByRole('heading', { name: 'New manager' })).toBeTruthy());
        expect(formError()).toBeNull();
      });
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

      await userEvent.click(submitButton());

      expect(screen.getByTestId('new-session-name')).toHaveAccessibleName('Name');
    });

    it('describes each invalid field with its error message', async () => {
      await renderForm(fakeApi(), { mode: 'manager' });

      await userEvent.click(submitButton());

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
});
