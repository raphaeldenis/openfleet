import { render, screen, waitFor, fireEvent } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@openfleet/shared';
import { SessionDetailsComponent } from './session-details.component';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

function baseSession(patch: Partial<Session> = {}): Session {
  return {
    id: 's1', name: 'Gimli · T6', emoji: '⛏️', directory: '/repo/.worktrees/t6', model: 'claude-sonnet-5',
    harness: 'claude-cli', state: 'idle', stateSince: '2026-09-26T10:00:00.000Z', permissionMode: 'manual',
    createdAt: '2026-09-26T09:00:00.000Z', ...patch,
  } as Session;
}

function fakeApi(overrides: Partial<Record<'updateModel' | 'closeSession' | 'sendInput' | 'renameSession', ReturnType<typeof vi.fn>>> = {}) {
  return {
    updateModel: vi.fn().mockResolvedValue({ status: 'deferred' }),
    closeSession: vi.fn(),
    sendInput: vi.fn(),
    renameSession: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function providersFor(session: Session, api: ReturnType<typeof fakeApi> = fakeApi()) {
  return [
    { provide: FleetApiService, useValue: api },
    { provide: FleetEventsService, useValue: { sessions: signal([session]), approvals: signal([]), managers: signal([]), connected: signal(true) } },
  ];
}

describe('SessionDetailsComponent', () => {
  beforeEach(() => localStorage.clear());

  it('renders the session name and state', async () => {
    const session = baseSession();
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session) });
    expect((screen.getByTestId('session-name-input') as HTMLInputElement).value).toBe('Gimli · T6');
    expect(screen.getByTestId('state-chip')).toHaveTextContent('idle');
  });

  it('renders the harness right away', async () => {
    const session = baseSession();
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session) });
    expect(screen.getByTestId('session-harness')).toHaveTextContent('claude-cli');
  });

  it('truncates a name wider than the field with an ellipsis instead of clipping it', async () => {
    const session = baseSession({ name: 'Gimli · T6 · make the desktop client reconnect to the daemon with exponential backoff' });
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session) });
    expect(getComputedStyle(screen.getByTestId('session-name-input')).textOverflow).toBe('ellipsis');
  });

  it('renames the session when the name field is committed', async () => {
    const session = baseSession();
    const api = fakeApi({ renameSession: vi.fn().mockResolvedValue({ ...session, name: 'Gimli · T7' }) });
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session, api) });

    const nameInput = screen.getByTestId('session-name-input') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Gimli · T7' } });

    await waitFor(() => expect(api.renameSession).toHaveBeenCalledWith('s1', { name: 'Gimli · T7' }));
  });

  it('changes the emoji when the emoji field is committed', async () => {
    const session = baseSession();
    const api = fakeApi({ renameSession: vi.fn().mockResolvedValue({ ...session, emoji: '🦉' }) });
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session, api) });

    const emojiInput = screen.getByTestId('session-emoji-input') as HTMLInputElement;
    fireEvent.change(emojiInput, { target: { value: '🦉' } });

    await waitFor(() => expect(api.renameSession).toHaveBeenCalledWith('s1', { emoji: '🦉' }));
  });

  it('does not send a request when the name field is committed unchanged', async () => {
    const session = baseSession();
    const api = fakeApi();
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session, api) });

    const nameInput = screen.getByTestId('session-name-input') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: session.name } });

    expect(api.renameSession).not.toHaveBeenCalled();
  });

  it('does not send a request when the name field is committed as whitespace only', async () => {
    const session = baseSession();
    const api = fakeApi();
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session, api) });

    const nameInput = screen.getByTestId('session-name-input') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: '   ' } });

    expect(api.renameSession).not.toHaveBeenCalled();
  });

  it('does not send a request when the emoji field is committed as whitespace only', async () => {
    const session = baseSession();
    const api = fakeApi();
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session, api) });

    const emojiInput = screen.getByTestId('session-emoji-input') as HTMLInputElement;
    fireEvent.change(emojiInput, { target: { value: '  ' } });

    expect(api.renameSession).not.toHaveBeenCalled();
  });

  it('sends only one rename request when the name field commits twice (Enter then blur) before the first request resolves', async () => {
    let resolveRename: (value: unknown) => void = () => {};
    const api = fakeApi({ renameSession: vi.fn(() => new Promise((resolve) => { resolveRename = resolve; })) });
    const session = baseSession();
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session, api) });

    const nameInput = screen.getByTestId('session-name-input') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Gimli · T7' } });
    fireEvent.change(nameInput, { target: { value: 'Gimli · T7' } });
    resolveRename({ ...session, name: 'Gimli · T7' });

    await waitFor(() => expect(api.renameSession).toHaveBeenCalled());
    expect(api.renameSession).toHaveBeenCalledTimes(1);
  });

  it('clears a previous rename error when the session switches, instead of leaking it onto the next session', async () => {
    const sessionA = baseSession({ id: 's1', name: 'Gimli' });
    const sessionB = baseSession({ id: 's2', name: 'Legolas' });
    const currentSession = signal<Session>(sessionA);
    const api = fakeApi({ renameSession: vi.fn().mockRejectedValue(new Error('boom')) });
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', currentSession)], providers: providersFor(sessionA, api) });

    const nameInput = screen.getByTestId('session-name-input') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Gimli renamed' } });
    await waitFor(() => expect(screen.getByTestId('session-rename-error')).toBeTruthy());

    currentSession.set(sessionB);

    await waitFor(() => expect(screen.queryByTestId('session-rename-error')).toBeNull());
  });

  it('restores the committed name and blurs without renaming when Escape is pressed', async () => {
    const session = baseSession();
    const api = fakeApi();
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session, api) });
    const nameInput = screen.getByTestId('session-name-input') as HTMLInputElement;

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Uncommitted name');
    await userEvent.keyboard('{Escape}');

    expect(nameInput.value).toBe(session.name);
    expect(nameInput).not.toHaveFocus();
    expect(api.renameSession).not.toHaveBeenCalled();
  });

  it('restores the committed emoji and blurs without renaming when Escape is pressed', async () => {
    const session = baseSession();
    const api = fakeApi();
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session, api) });
    const emojiInput = screen.getByTestId('session-emoji-input') as HTMLInputElement;

    await userEvent.clear(emojiInput);
    await userEvent.type(emojiInput, '🦉');
    await userEvent.keyboard('{Escape}');

    expect(emojiInput.value).toBe(session.emoji);
    expect(emojiInput).not.toHaveFocus();
    expect(api.renameSession).not.toHaveBeenCalled();
  });

  it('still commits the next real rename after an Escape cancels a previous edit', async () => {
    const session = baseSession();
    const api = fakeApi();
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session, api) });
    const nameInput = screen.getByTestId('session-name-input') as HTMLInputElement;

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Uncommitted name');
    await userEvent.keyboard('{Escape}');
    expect(api.renameSession).not.toHaveBeenCalled();

    nameInput.focus();
    fireEvent.change(nameInput, { target: { value: 'Gimli · T7' } });

    await waitFor(() => expect(api.renameSession).toHaveBeenCalledWith('s1', { name: 'Gimli · T7' }));
  });

  it('still commits the next real emoji change after an Escape cancels a previous edit', async () => {
    const session = baseSession();
    const api = fakeApi();
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session, api) });
    const emojiInput = screen.getByTestId('session-emoji-input') as HTMLInputElement;

    await userEvent.clear(emojiInput);
    await userEvent.type(emojiInput, '🦉');
    await userEvent.keyboard('{Escape}');
    expect(api.renameSession).not.toHaveBeenCalled();

    emojiInput.focus();
    fireEvent.change(emojiInput, { target: { value: '🐉' } });

    await waitFor(() => expect(api.renameSession).toHaveBeenCalledWith('s1', { emoji: '🐉' }));
  });

  it('discards an uncommitted name edit instead of committing it when the session switches', async () => {
    const sessionA = baseSession({ id: 's1', name: 'Gimli' });
    const sessionB = baseSession({ id: 's2', name: 'Legolas' });
    const currentSession = signal<Session>(sessionA);
    const api = fakeApi();
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', currentSession)], providers: providersFor(sessionA, api) });
    const nameInput = screen.getByTestId('session-name-input') as HTMLInputElement;

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Uncommitted name');

    currentSession.set(sessionB);

    await waitFor(() => expect(nameInput.value).toBe('Legolas'));
    expect(api.renameSession).not.toHaveBeenCalled();
  });

  it('shows an inline error when renaming fails', async () => {
    const session = baseSession();
    const api = fakeApi({ renameSession: vi.fn().mockRejectedValue(new Error('boom')) });
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session, api) });

    const nameInput = screen.getByTestId('session-name-input') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Gimli · T7' } });

    await waitFor(() => expect(screen.getByTestId('session-rename-error')).toHaveTextContent(/could not rename/i));
  });

  it('tells the user a rename of a vanished session cannot be retried', async () => {
    const session = baseSession();
    const sessionGone = new ApiError(404, 'PATCH /sessions/s1', 'session_not_found');
    const api = fakeApi({ renameSession: vi.fn().mockRejectedValue(sessionGone) });
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session, api) });

    fireEvent.change(screen.getByTestId('session-name-input'), { target: { value: 'Gimli · T7' } });

    await waitFor(() => expect(screen.getByTestId('session-rename-error')).toHaveTextContent('That session no longer exists.'));
  });

  it('drops the failure of a name edit once the next emoji edit starts', async () => {
    const session = baseSession();
    const api = fakeApi({ renameSession: vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({}) });
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session, api) });
    fireEvent.change(screen.getByTestId('session-name-input'), { target: { value: 'Gimli · T7' } });
    await waitFor(() => expect(screen.getByTestId('session-rename-error')).toBeTruthy());

    fireEvent.change(screen.getByTestId('session-emoji-input'), { target: { value: '🦉' } });

    await waitFor(() => expect(screen.queryByTestId('session-rename-error')).toBeNull());
  });

  it('a rename request for a previous session settling late does not surface its error on the new session, nor release the new session\'s own busy flag', async () => {
    const sessionA = baseSession({ id: 's1', name: 'Gimli' });
    const sessionB = baseSession({ id: 's2', name: 'Legolas' });
    const currentSession = signal<Session>(sessionA);
    let rejectA: (reason?: unknown) => void = () => {};
    let resolveB: (value: unknown) => void = () => {};
    const renameSession = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectA = reject; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
    const api = fakeApi({ renameSession });
    const { fixture } = await render(SessionDetailsComponent, { bindings: [inputBinding('session', currentSession)], providers: providersFor(sessionA, api) });
    const nameInput = screen.getByTestId('session-name-input') as HTMLInputElement;

    fireEvent.change(nameInput, { target: { value: 'Gimli renamed' } }); // session A's rename is now in flight, unresolved

    currentSession.set(sessionB);
    await waitFor(() => expect((screen.getByTestId('session-name-input') as HTMLInputElement).value).toBe('Legolas'));

    fireEvent.change(nameInput, { target: { value: 'Legolas renamed' } }); // session B's own rename, also in flight
    await waitFor(() => expect(renameSession).toHaveBeenCalledTimes(2));

    rejectA(new Error('boom'));
    await fixture.whenStable();

    expect(screen.queryByTestId('session-rename-error')).toBeNull();

    // B's own in-flight request must still be tracked as busy: a second commit is guarded, not sent.
    fireEvent.change(nameInput, { target: { value: 'Legolas renamed again' } });
    expect(renameSession).toHaveBeenCalledTimes(2);

    resolveB({});
  });

  it('keeps a rename of A guarded, and its failure visible, after A → B → A', async () => {
    const sessionA = baseSession({ id: 's1', name: 'Gimli' });
    const sessionB = baseSession({ id: 's2', name: 'Legolas' });
    const currentSession = signal<Session>(sessionA);
    let rejectRename: (reason?: unknown) => void = () => {};
    const renameSession = vi.fn(() => new Promise((_resolve, reject) => { rejectRename = reject; }));
    const { fixture } = await render(SessionDetailsComponent, {
      bindings: [inputBinding('session', currentSession)],
      providers: providersFor(sessionA, fakeApi({ renameSession })),
    });
    fireEvent.change(screen.getByTestId('session-name-input'), { target: { value: 'Gimli renamed' } });
    currentSession.set(sessionB);
    await fixture.whenStable();
    currentSession.set(sessionA);
    await fixture.whenStable();

    fireEvent.change(screen.getByTestId('session-name-input'), { target: { value: 'Gimli renamed again' } });
    expect(renameSession).toHaveBeenCalledTimes(1);
    rejectRename(new Error('boom'));

    await waitFor(() => expect(screen.getByTestId('session-rename-error')).toHaveTextContent(/could not rename/i));
  });

  it('renaming the name field does not block a concurrent emoji edit — separate busy flags', async () => {
    let resolveNameRename: (value: unknown) => void = () => {};
    const renameSession = vi.fn(() => new Promise((resolve) => { resolveNameRename = resolve; }));
    const api = fakeApi({ renameSession });
    const session = baseSession();
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session, api) });
    const nameInput = screen.getByTestId('session-name-input') as HTMLInputElement;
    const emojiInput = screen.getByTestId('session-emoji-input') as HTMLInputElement;

    fireEvent.change(nameInput, { target: { value: 'Gimli renamed' } }); // name rename in flight, unresolved

    fireEvent.change(emojiInput, { target: { value: '🦉' } }); // must still go through on its own busy flag

    await waitFor(() => expect(renameSession).toHaveBeenCalledTimes(2));
    expect(renameSession).toHaveBeenCalledWith('s1', { name: 'Gimli renamed' });
    expect(renameSession).toHaveBeenCalledWith('s1', { emoji: '🦉' });

    resolveNameRename({});
  });

  it('shows the exit code next to the chip once the session is closed', async () => {
    const session = baseSession({ state: 'closed', exitCode: 1 });
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session) });
    expect(screen.getByTestId('session-exit-code')).toHaveTextContent('closed · exit 1');
  });

  it('writes the exit code in the muted text colour', async () => {
    const session = baseSession({ state: 'closed', exitCode: 1 });
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session) });
    expect(getComputedStyle(screen.getByTestId('session-exit-code')).color).toBe('var(--mut)');
  });

  it('shows a bare "closed" with no exit number when the daemon omits the exit code', async () => {
    const session = baseSession({ state: 'closed' });
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session) });
    expect(screen.getByTestId('session-exit-code')).toHaveTextContent('closed');
    expect(screen.getByTestId('session-exit-code')).not.toHaveTextContent('exit');
  });

  it('renders the worktree directory', async () => {
    const session = baseSession();
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session) });
    expect(screen.getByTestId('session-directory')).toHaveTextContent('/repo/.worktrees/t6');
  });

  it('renders the model selector for this session', async () => {
    const session = baseSession();
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session) });
    expect(screen.getByTestId('current-model')).toHaveTextContent('claude-sonnet-5');
  });

  it('renders the permission mode on its popover button', async () => {
    const session = baseSession();
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session) });
    expect(screen.getByTestId('permission-mode')).toHaveTextContent('manual');
  });

  it('offers a Close action for an open session', async () => {
    const session = baseSession();
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session) });
    expect(screen.getByTestId('session-close')).toBeTruthy();
  });

  it('warns the close-confirm dialog of a pending model switch reported by the model selector', async () => {
    const session = baseSession();
    await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session) });

    await userEvent.click(screen.getByTestId('model-trigger'));
    await userEvent.click(await screen.findByRole('option', { name: 'opus' }));
    await waitFor(() => expect(screen.getByTestId('model-switch-status')).toHaveTextContent('switch pending'));

    await userEvent.click(screen.getByTestId('session-close'));

    expect(screen.getByTestId('close-confirm-pending-switch')).toBeTruthy();
  });

  describe('always open', () => {
    it('shows harness, directory, model, permission mode, Write handoff and Close right away', async () => {
      const session = baseSession();
      await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session) });

      expect(screen.getByTestId('session-details')).toBeTruthy();
      for (const visibleTestId of ['session-harness', 'session-directory', 'current-model', 'permission-mode', 'session-write-handoff', 'session-close']) {
        expect(screen.getByTestId(visibleTestId)).toBeTruthy();
      }
    });

    it('offers no Details toggle', async () => {
      const session = baseSession();
      await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session) });

      expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
    });

    it('shows the permission mode picker for the bypassPermissions mode', async () => {
      const session = baseSession({ permissionMode: 'bypassPermissions' });
      await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session) });

      expect(screen.getByTestId('permission-mode')).toBeTruthy();
    });

    it('offers Write handoff on a closed session', async () => {
      const session = baseSession({ state: 'closed', exitCode: 0 });
      await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session) });

      expect(screen.getByRole('button', { name: 'Write handoff' })).toBeTruthy();
    });

    it('shows no Interrupt button even while generating (it lives in the terminal tab bar)', async () => {
      const session = baseSession({ state: 'generating' });
      await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session) });

      expect(screen.queryByRole('button', { name: 'Interrupt' })).toBeNull();
      expect(screen.queryByTestId('session-interrupt')).toBeNull();
    });
  });

  describe('identity row', () => {
    it('holds the emoji and name fields', async () => {
      const session = baseSession();
      await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session) });

      const row = screen.getByTestId('session-details-identity');

      expect(row).toContainElement(screen.getByTestId('session-emoji-input'));
      expect(row).toContainElement(screen.getByTestId('session-name-input'));
    });

    it('makes the emoji and name fields 2rem tall', async () => {
      const session = baseSession();
      await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session) });

      expect(getComputedStyle(screen.getByTestId('session-emoji-input')).height).toBe('2rem');
      expect(getComputedStyle(screen.getByTestId('session-name-input')).height).toBe('2rem');
    });
  });

  describe('model drift chip', () => {
    it('shows the drift chip, with the previous model in its tooltip, when the model changed under the session', async () => {
      const session = baseSession({ modelDriftedFrom: 'claude-opus-4-0' });
      await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session) });

      const chip = screen.getByTestId('session-drift-chip');

      expect(chip).toHaveTextContent('⇄ drift');
      expect(chip).toHaveAttribute('title', expect.stringContaining('claude-opus-4-0'));
    });

    it('shows no drift chip when the model did not drift', async () => {
      const session = baseSession();
      await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session) });
  
      expect(screen.queryByTestId('session-drift-chip')).toBeNull();
    });
  });

  describe('elapsed time', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('shows the time elapsed since the state last changed, next to the state chip', async () => {
      vi.setSystemTime(new Date('2026-09-26T10:00:40.000Z'));
      const session = baseSession({ stateSince: '2026-09-26T10:00:00.000Z' });
      await render(SessionDetailsComponent, { bindings: [inputBinding('session', () => session)], providers: providersFor(session) });
      expect(screen.getByTestId('state-chip-elapsed')).toHaveTextContent('0:40');
    });
  });
});
