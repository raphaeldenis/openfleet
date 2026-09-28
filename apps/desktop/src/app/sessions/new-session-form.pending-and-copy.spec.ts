import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { NewSessionFormComponent } from './new-session-form.component';
import { ApiError, FleetApiService } from '../core/fleet-api.service';

// The /new form keeps the keyboard focus while a create is pending (a disabled element loses it in a
// real browser), reads its errors in the vocabulary of the mode, and lists the permission modes like the mockup.

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
  return { fixture, navigateSpy };
}

function pendingCreate() {
  let resolveCreate!: (session: { id: string }) => void;
  const create = vi.fn(() => new Promise((resolve) => { resolveCreate = resolve; }));
  return { create, resolveCreate: (session: { id: string }) => resolveCreate(session) };
}

const radio = (name: string) => screen.getByRole('radio', { name });
const submitButton = () => screen.getByTestId('new-session-submit');
const formError = () => screen.queryByTestId('new-session-form-error');

async function fillSessionFields({ directory = '/tmp/wt', name = 'Gimli' } = {}): Promise<void> {
  await userEvent.type(screen.getByTestId('new-session-directory'), directory);
  await userEvent.type(screen.getByTestId('new-session-name'), name);
}

async function fillManagerMission(mission = 'Ship phase 2'): Promise<void> {
  await userEvent.type(screen.getByTestId('manager-mission'), mission);
}

async function renderFormWithPendingCreate(queryParams: Record<string, string> = {}) {
  const { create, resolveCreate } = pendingCreate();
  const isManager = queryParams['mode'] === 'manager';
  const api = fakeApi(isManager ? { createManagerSession: create } : { createSession: create });
  await renderForm(api, queryParams);
  await fillSessionFields();
  if (isManager) await fillManagerMission();
  return { api, create, resolveCreate };
}

describe('NewSessionFormComponent — focus stays put while a create is pending', () => {
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

  it('the harness and model selects keep the value the create was sent with while it is pending', async () => {
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
    expect(screen.getByTestId('manager-pulse-seconds')).toHaveValue(1800);
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
});

describe('NewSessionFormComponent — permission mode list as in the mockup', () => {
  it('lists the modes with inherited first and bypassPermissions last', async () => {
    await renderForm(fakeApi());

    const listedModes = screen.getAllByRole('radio').map((each) => each.getAttribute('value'));

    expect(listedModes).toEqual(['', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);
  });

  it('shows the full description of a mode as a tooltip, since the row shows one ellipsized line', async () => {
    await renderForm(fakeApi());

    const explanation = screen.getByText(/File edits run without asking/);

    expect(explanation.closest('label')).toHaveAttribute('title', explanation.textContent!.trim());
  });
});

describe('NewSessionFormComponent — errors follow the form', () => {
  const editName = () => userEvent.type(screen.getByTestId('new-session-name'), '!');

  it('a create error disappears as soon as the user edits a field', async () => {
    await renderForm(fakeApi({ createSession: vi.fn().mockRejectedValue(new ApiError(500, 'boom', 'internal')) }));
    await fillSessionFields();
    await userEvent.click(submitButton());
    expect(formError()).toBeTruthy();

    await editName();

    expect(formError()).toBeNull();
  });

  it('a create error disappears when the user switches between session and manager', async () => {
    await renderForm(fakeApi({ createSession: vi.fn().mockRejectedValue(new ApiError(500, 'boom', 'internal')) }));
    await fillSessionFields();
    await userEvent.click(submitButton());
    expect(formError()).toBeTruthy();

    await userEvent.click(screen.getByTestId('new-session-mode-manager'));

    expect(formError()).toBeNull();
  });

  it('a create error stays while the form is left as it was', async () => {
    await renderForm(fakeApi({ createSession: vi.fn().mockRejectedValue(new ApiError(500, 'boom', 'internal')) }));
    await fillSessionFields();

    await userEvent.click(submitButton());
    await userEvent.tab();

    expect(formError()).toBeTruthy();
  });

  it('the "created but not opened" line disappears as soon as the user edits a field', async () => {
    const { navigateSpy } = await renderForm(fakeApi());
    navigateSpy.mockResolvedValueOnce(false);
    await fillSessionFields();
    await userEvent.click(submitButton());
    expect(formError()).toHaveTextContent('was created');

    await editName();

    expect(formError()).toBeNull();
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

describe('NewSessionFormComponent — the manager form talks about a manager', () => {
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

  it('a session that was created but not opened is still called a session', async () => {
    const { navigateSpy } = await renderForm(fakeApi());
    navigateSpy.mockResolvedValueOnce(false);
    await fillSessionFields();

    await userEvent.click(submitButton());

    expect(formError()).toHaveTextContent('The session was created but could not be opened');
  });
});
