import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandoffPreview, Session } from '@openfleet/shared';
import { SessionHeaderComponent } from './session-header.component';
import { ApiError, FleetApiService } from '../core/fleet-api.service';
import { FleetEventsService } from '../core/fleet-events.service';

function aSession(patch: Partial<Session> = {}): Session {
  return {
    id: 's1', name: 'Gimli · T6', emoji: '⛏️', directory: '/repo/.worktrees/t6', model: 'claude-sonnet-5',
    harness: 'claude-cli', state: 'idle', stateSince: '2026-09-26T10:00:00.000Z', permissionMode: 'manual',
    createdAt: '2026-09-26T09:00:00.000Z', ...patch,
  } as Session;
}

function previewFor(sessionId: string, patch: Partial<HandoffPreview> = {}): HandoffPreview {
  return {
    sessionId,
    kind: 'session',
    sections: { goal: `Goal of ${sessionId}`, state: 'idle on main', decisions: '', filesTouched: ' M panel.ts', nextSteps: '- wire the host', openQuestions: '' },
    sources: { goal: 'none', state: 'session', decisions: 'none', filesTouched: 'git', nextSteps: 'working_state', openQuestions: 'none' },
    truncated: [],
    target: { available: false, reason: 'no_project', writeOnCloseDefault: false },
    generatedAt: '2026-10-04T10:00:00.000Z',
    ...patch,
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((res) => (resolve = res));
  return { promise, resolve };
}

function envelopeError(code: string, status: number) {
  const envelope = { error: code, kind: 'not_found', retry: 'never', message: 'raw daemon words' };
  return new ApiError(status, 'GET /x', code, envelope as never);
}

async function renderHeader(session: Session, getHandoffPreview = vi.fn((id: string) => Promise.resolve(previewFor(id)))) {
  const currentSession = signal(session);
  const api = { updateModel: vi.fn(), closeSession: vi.fn(), sendInput: vi.fn(), renameSession: vi.fn(), getHandoffPreview };
  await render(SessionHeaderComponent, {
    bindings: [inputBinding('session', currentSession)],
    providers: [
      { provide: FleetApiService, useValue: api },
      { provide: FleetEventsService, useValue: { sessions: signal([session]), approvals: signal([]), managers: signal([]), connected: signal(true) } },
    ],
  });
  return { session: currentSession, getHandoffPreview };
}

const openDetails = () => userEvent.click(screen.getByRole('button', { name: 'Details' }));
const writeHandoffButton = () => screen.getByRole('button', { name: 'Write handoff' });
const panel = () => screen.queryByRole('dialog', { name: 'Handoff preview' });

describe('SessionHeaderComponent write handoff', () => {
  beforeEach(() => localStorage.clear());

  it.each([
    ['an open session', aSession({ state: 'idle' })],
    ['a closed session', aSession({ state: 'closed', exitCode: 1 })],
  ])('offers the Write handoff button in the open details of %s', async (_label, session) => {
    await renderHeader(session);
    await openDetails();

    expect(writeHandoffButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the Write handoff button out of the collapsed header', async () => {
    await renderHeader(aSession());

    expect(screen.queryByRole('button', { name: 'Write handoff' })).toBeNull();
  });

  it('asks the daemon for nothing, and shows no panel, until the button is pressed', async () => {
    const { getHandoffPreview } = await renderHeader(aSession());
    await openDetails();

    expect(getHandoffPreview).not.toHaveBeenCalled();
    expect(panel()).toBeNull();
  });

  it('shows the collecting state while the preview is being fetched', async () => {
    const pending = deferred<HandoffPreview>();
    await renderHeader(aSession(), vi.fn(() => pending.promise));
    await openDetails();

    await userEvent.click(writeHandoffButton());

    expect(await screen.findByText('Collecting the state…')).toBeTruthy();
    expect(writeHandoffButton()).toHaveAttribute('aria-expanded', 'true');
    pending.resolve(previewFor('s1'));
  });

  it('shows the six sections of the preview of this session once collected, as a dialog whose title takes focus', async () => {
    const { getHandoffPreview } = await renderHeader(aSession());
    await openDetails();

    await userEvent.click(writeHandoffButton());

    expect(await screen.findByRole('textbox', { name: /Goal/ })).toHaveValue('Goal of s1');
    expect(screen.getByRole('textbox', { name: /Files touched/ })).toHaveValue(' M panel.ts');
    expect(getHandoffPreview).toHaveBeenCalledWith('s1');
    expect(panel()).toHaveAttribute('aria-modal', 'false');
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByText('Handoff preview')));
  });

  it('keeps Save off with the reason when the session has no docs folder', async () => {
    await renderHeader(aSession());
    await openDetails();

    await userEvent.click(writeHandoffButton());

    await screen.findByRole('textbox', { name: /Goal/ });
    const save = screen.getByRole('button', { name: 'Save handoff' });
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(save).toHaveAccessibleDescription('Save is off: this project has no docs folder yet.');
  });

  it('says saving is not available yet when the daemon target is usable and Save is pressed', async () => {
    const usable = previewFor('s1', { target: { available: true, relativePath: 'handoffs/2026-10-04-gimli.md', writeOnCloseDefault: true } });
    await renderHeader(aSession(), vi.fn(() => Promise.resolve(usable)));
    await openDetails();
    await userEvent.click(writeHandoffButton());

    await screen.findByRole('textbox', { name: /Goal/ });
    await userEvent.click(screen.getByRole('button', { name: 'Save handoff' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Saving handoffs is not available yet.');
    expect(screen.getByRole('textbox', { name: /Goal/ })).toHaveValue('Goal of s1');
  });

  it('closes the panel and gives focus back to the button on Cancel', async () => {
    await renderHeader(aSession());
    await openDetails();
    await userEvent.click(writeHandoffButton());

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await vi.waitFor(() => expect(panel()).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(writeHandoffButton()));
    expect(writeHandoffButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the panel and gives focus back to the button on Escape', async () => {
    await renderHeader(aSession());
    await openDetails();
    await userEvent.click(writeHandoffButton());
    await screen.findByRole('textbox', { name: /Goal/ });

    await userEvent.keyboard('{Escape}');

    await vi.waitFor(() => expect(panel()).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(writeHandoffButton()));
  });

  it('closes the panel when the button is pressed again', async () => {
    await renderHeader(aSession());
    await openDetails();
    await userEvent.click(writeHandoffButton());
    await screen.findByRole('dialog', { name: 'Handoff preview' });

    await userEvent.click(writeHandoffButton());

    await vi.waitFor(() => expect(panel()).toBeNull());
  });

  it('says the session is gone, in the words of the error table, when the daemon does not know it', async () => {
    await renderHeader(aSession(), vi.fn(() => Promise.reject(envelopeError('session_not_found', 404))));
    await openDetails();

    await userEvent.click(writeHandoffButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('That session no longer exists.');
  });

  it('says the preview could not be collected when the daemon cannot be reached, and collects it again on Try again', async () => {
    const getHandoffPreview = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(previewFor('s1'));
    await renderHeader(aSession(), getHandoffPreview);
    await openDetails();
    await userEvent.click(writeHandoffButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('The handoff preview could not be collected — check your connection, then try again.');

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('textbox', { name: /Goal/ })).toHaveValue('Goal of s1');
    expect(getHandoffPreview).toHaveBeenCalledTimes(2);
  });

  describe('when the session shown changes', () => {
    it('drops the open panel instead of showing the preview of the other session', async () => {
      const { session } = await renderHeader(aSession({ id: 's1' }));
      await openDetails();
      await userEvent.click(writeHandoffButton());
      await screen.findByRole('textbox', { name: /Goal/ });

      session.set(aSession({ id: 's2' }));

      await vi.waitFor(() => expect(panel()).toBeNull());
      expect(screen.queryByDisplayValue('Goal of s1')).toBeNull();
    });

    it('never opens the panel by itself for the new session', async () => {
      const { session, getHandoffPreview } = await renderHeader(aSession({ id: 's1' }));
      await openDetails();
      await userEvent.click(writeHandoffButton());
      await screen.findByRole('textbox', { name: /Goal/ });

      session.set(aSession({ id: 's2' }));
      await vi.waitFor(() => expect(panel()).toBeNull());

      expect(getHandoffPreview).toHaveBeenCalledTimes(1);
      expect(getHandoffPreview).not.toHaveBeenCalledWith('s2');
    });

    it('ignores a preview of the old session that arrives after the switch', async () => {
      const slow = deferred<HandoffPreview>();
      const getHandoffPreview = vi.fn((id: string) => (id === 's1' ? slow.promise : Promise.resolve(previewFor(id))));
      const { session } = await renderHeader(aSession({ id: 's1' }), getHandoffPreview);
      await openDetails();
      await userEvent.click(writeHandoffButton());
      await screen.findByText('Collecting the state…');

      session.set(aSession({ id: 's2' }));
      await vi.waitFor(() => expect(panel()).toBeNull());
      slow.resolve(previewFor('s1'));
      await openDetails();
      await userEvent.click(writeHandoffButton());

      expect(await screen.findByRole('textbox', { name: /Goal/ })).toHaveValue('Goal of s2');
      expect(screen.queryByDisplayValue('Goal of s1')).toBeNull();
    });
  });
});
