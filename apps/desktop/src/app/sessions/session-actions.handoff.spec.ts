import { render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, signal } from '@angular/core';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { CloseHandoffResult, HandoffTarget, SessionState } from '@openfleet/shared';
import { SessionActionsComponent } from './session-actions.component';
import { FleetApiService } from '../core/fleet-api.service';
import { deferred, settleRequests } from '../testing/session-view.testing';

// jsdom lets focus() land inside an inert subtree, where a real browser drops it onto <body>.
const nativeFocus = HTMLElement.prototype.focus;
beforeAll(() => {
  HTMLElement.prototype.focus = function focusUnlessInert(this: HTMLElement, options?: FocusOptions): void {
    if (this.closest('[inert]')) return;
    nativeFocus.call(this, options);
  };
});
afterAll(() => {
  HTMLElement.prototype.focus = nativeFocus;
});

const USABLE_TARGET: HandoffTarget = { available: true, relativePath: 'handoffs/2026-10-04-gimli.md', writeOnCloseDefault: true };
const USABLE_TARGET_WITH_SETTING_OFF: HandoffTarget = { ...USABLE_TARGET, writeOnCloseDefault: false };
const targetWithout = (reason: NonNullable<HandoffTarget['reason']>): HandoffTarget => ({ available: false, reason, writeOnCloseDefault: false });

function apiWith(options: { target?: Promise<HandoffTarget>; closed?: Promise<{ handoff?: CloseHandoffResult }> } = {}) {
  const { target = Promise.resolve(USABLE_TARGET), closed = Promise.resolve({}) } = options;
  return { closeSession: vi.fn().mockReturnValue(closed), getHandoffTarget: vi.fn().mockReturnValue(target), sendInput: vi.fn() };
}

const renderIdle = (api: ReturnType<typeof apiWith>, state: SessionState = 'idle') =>
  render(SessionActionsComponent, {
    bindings: [inputBinding('sessionId', () => 's1'), inputBinding('state', () => state), inputBinding('stateSince', () => 't1'), inputBinding('sessionName', () => 'Gimli')],
    providers: [{ provide: FleetApiService, useValue: api }],
  });

async function openCloseDialog(): Promise<void> {
  await userEvent.click(screen.getByTestId('session-close'));
}
const checkbox = () => screen.getByRole('checkbox', { name: /write a handoff when this session closes/i }) as HTMLInputElement;
const checkboxReady = () => waitFor(() => expect(checkbox()).toBeEnabled());

describe('SessionActionsComponent close dialog: write a handoff', () => {
  describe('the checkbox', () => {
    it('is checked and shows the file it writes when the project has a usable docs folder and the setting is on', async () => {
      await renderIdle(apiWith());

      await openCloseDialog();

      await checkboxReady();
      expect(checkbox()).toBeChecked();
      expect(screen.getByTestId('close-confirm-dialog')).toHaveTextContent('handoffs/2026-10-04-gimli.md');
    });

    it('is unchecked but available when the setting is off', async () => {
      await renderIdle(apiWith({ target: Promise.resolve(USABLE_TARGET_WITH_SETTING_OFF) }));

      await openCloseDialog();

      await checkboxReady();
      expect(checkbox()).not.toBeChecked();
    });

    it.each([
      ['no_project', 'No handoff: this project has no docs folder yet.'],
      ['no_docs_folder', 'No handoff: this project has no docs folder yet.'],
      ['docs_folder_unusable', 'No handoff: the docs folder is not writable.'],
    ] as const)('is disabled and unchecked with a visible reason when the target is unavailable (%s)', async (reason, sentence) => {
      await renderIdle(apiWith({ target: Promise.resolve(targetWithout(reason)) }));

      await openCloseDialog();

      const reasonLine = await screen.findByText(sentence);
      expect(checkbox()).toBeDisabled();
      expect(checkbox()).not.toBeChecked();
      expect(checkbox().getAttribute('aria-describedby')).toBe(reasonLine.closest('[id]')?.id);
    });

    it('is disabled with a polite line when the target cannot be fetched, and closing still works', async () => {
      const api = { ...apiWith(), getHandoffTarget: vi.fn().mockRejectedValue(new Error('offline')) };
      await renderIdle(api);

      await openCloseDialog();

      await screen.findByText("Couldn't check the docs folder. Closing still works.");
      expect(checkbox()).toBeDisabled();
      await userEvent.click(screen.getByTestId('close-confirm-submit'));
      expect(api.closeSession).toHaveBeenCalledWith('s1');
    });

    it('stays disabled while the target is being fetched', async () => {
      await renderIdle(apiWith({ target: new Promise(() => {}) }));

      await openCloseDialog();

      expect(checkbox()).toBeDisabled();
    });
  });

  describe('confirming', () => {
    it('asks the daemon to write the handoff when the box is checked', async () => {
      const api = apiWith();
      await renderIdle(api);
      await openCloseDialog();
      await checkboxReady();

      await userEvent.click(screen.getByTestId('close-confirm-submit'));

      expect(api.closeSession).toHaveBeenCalledWith('s1', { writeHandoff: true });
    });

    it('closes without a handoff when the box is unchecked', async () => {
      const api = apiWith();
      await renderIdle(api);
      await openCloseDialog();
      await checkboxReady();
      await userEvent.click(checkbox());

      await userEvent.click(screen.getByTestId('close-confirm-submit'));

      expect(api.closeSession).toHaveBeenCalledWith('s1');
    });

    it('forgets the choice when the dialog is cancelled and reopened', async () => {
      const api = apiWith();
      await renderIdle(api);
      await openCloseDialog();
      await checkboxReady();
      await userEvent.click(checkbox());
      await userEvent.click(screen.getByTestId('close-confirm-cancel'));

      await openCloseDialog();

      await checkboxReady();
      expect(checkbox()).toBeChecked();
    });

    it('sends no request when Escape is pressed', async () => {
      const api = apiWith();
      await renderIdle(api);
      await openCloseDialog();
      await checkboxReady();

      await userEvent.keyboard('{Escape}');

      expect(api.closeSession).not.toHaveBeenCalled();
      expect(screen.queryByTestId('close-confirm-dialog')).toBeNull();
    });
  });

  describe('the Tab trap', () => {
    it('cycles the checkbox, Cancel and Close session in page order, in both directions', async () => {
      await renderIdle(apiWith());
      await openCloseDialog();
      await checkboxReady();
      const cancel = screen.getByTestId('close-confirm-cancel');
      const submit = screen.getByTestId('close-confirm-submit');
      await waitFor(() => expect(cancel).toHaveFocus());

      await userEvent.tab();
      expect(submit).toHaveFocus();
      await userEvent.tab();
      expect(checkbox()).toHaveFocus();
      await userEvent.tab();
      expect(cancel).toHaveFocus();
      await userEvent.tab({ shift: true });
      expect(checkbox()).toHaveFocus();
      await userEvent.tab({ shift: true });
      expect(submit).toHaveFocus();
    });

    it('skips a disabled checkbox', async () => {
      await renderIdle(apiWith({ target: Promise.resolve(targetWithout('no_project')) }));
      await openCloseDialog();
      await screen.findByText('No handoff: this project has no docs folder yet.');
      const cancel = screen.getByTestId('close-confirm-cancel');
      const submit = screen.getByTestId('close-confirm-submit');
      await waitFor(() => expect(cancel).toHaveFocus());

      await userEvent.tab();

      expect(submit).toHaveFocus();
    });
  });

  describe('after the close', () => {
    it('says the close went through and why the handoff was not written', async () => {
      const failed: CloseHandoffResult = { status: 'failed', error: 'docs_folder_not_writable', message: 'the docs folder is not writable.' };
      await renderIdle(apiWith({ closed: Promise.resolve({ handoff: failed }) }));
      await openCloseDialog();
      await checkboxReady();

      await userEvent.click(screen.getByTestId('close-confirm-submit'));

      const notice = await screen.findByTestId('close-handoff-notice');
      expect(notice).toHaveAttribute('role', 'status');
      expect(notice).toHaveTextContent('Closed. The handoff was not written: the docs folder is not writable.');
    });

    it.each<CloseHandoffResult>([
      { status: 'written', relativePath: 'handoffs/2026-10-04-gimli.md' },
      { status: 'skipped', reason: 'recent_manual_handoff' },
    ])('shows no notice when the handoff is $status', async (result) => {
      const api = apiWith({ closed: Promise.resolve({ handoff: result }) });
      await renderIdle(api);
      await openCloseDialog();
      await checkboxReady();

      await userEvent.click(screen.getByTestId('close-confirm-submit'));

      await waitFor(() => expect(api.closeSession).toHaveBeenCalled());
      expect(screen.queryByTestId('close-handoff-notice')).toBeNull();
    });

    it('drops the notice when the component moves to another session', async () => {
      const sessionId = signal('s1');
      const failed: CloseHandoffResult = { status: 'failed', error: 'docs_folder_not_writable', message: 'the docs folder is not writable.' };
      await render(SessionActionsComponent, {
        bindings: [inputBinding('sessionId', sessionId), inputBinding('state', () => 'idle' as const), inputBinding('stateSince', () => 't1'), inputBinding('sessionName', () => 'Gimli')],
        providers: [{ provide: FleetApiService, useValue: apiWith({ closed: Promise.resolve({ handoff: failed }) }) }],
      });
      await openCloseDialog();
      await checkboxReady();
      await userEvent.click(screen.getByTestId('close-confirm-submit'));
      await screen.findByTestId('close-handoff-notice');

      sessionId.set('s2');

      await waitFor(() => expect(screen.queryByTestId('close-handoff-notice')).toBeNull());
    });
  });

  describe('a late answer for an earlier opening of the dialog, on the same session', () => {
    it('never flips the choice the user made in the current opening', async () => {
      const firstOpeningTarget = deferred<HandoffTarget>();
      const secondOpeningTarget = deferred<HandoffTarget>();
      const api = { ...apiWith(), getHandoffTarget: vi.fn().mockReturnValueOnce(firstOpeningTarget.promise).mockReturnValueOnce(secondOpeningTarget.promise) };
      const { fixture } = await renderIdle(api);
      await openCloseDialog();
      await userEvent.click(screen.getByTestId('close-confirm-cancel'));
      await openCloseDialog();
      secondOpeningTarget.resolve(USABLE_TARGET);
      await checkboxReady();
      await userEvent.click(checkbox());
      expect(checkbox()).not.toBeChecked();

      firstOpeningTarget.resolve(USABLE_TARGET);
      await settleRequests(fixture);

      expect(checkbox()).not.toBeChecked();
    });

    it('never fills a dialog that was cancelled before the answer arrived', async () => {
      const slowTarget = deferred<HandoffTarget>();
      const api = { ...apiWith(), getHandoffTarget: vi.fn().mockReturnValueOnce(slowTarget.promise).mockReturnValueOnce(new Promise(() => {})) };
      const { fixture } = await renderIdle(api);
      await openCloseDialog();
      await userEvent.click(screen.getByTestId('close-confirm-cancel'));
      await openCloseDialog();

      slowTarget.resolve(USABLE_TARGET);
      await settleRequests(fixture);

      expect(checkbox()).toBeDisabled();
    });
  });

  describe('a late answer for another session', () => {
    it('never decides the checkbox of the dialog opened for the current session', async () => {
      const sessionId = signal('s1');
      const slowTargetOfS1 = deferred<HandoffTarget>();
      const api = {
        closeSession: vi.fn().mockResolvedValue({}),
        sendInput: vi.fn(),
        getHandoffTarget: vi.fn((id: string) => (id === 's1' ? slowTargetOfS1.promise : Promise.resolve(targetWithout('no_project')))),
      };
      const { fixture } = await render(SessionActionsComponent, {
        bindings: [inputBinding('sessionId', sessionId), inputBinding('state', () => 'idle' as const), inputBinding('stateSince', () => 't1'), inputBinding('sessionName', () => 'Gimli')],
        providers: [{ provide: FleetApiService, useValue: api }],
      });
      await openCloseDialog();
      sessionId.set('s2');
      await waitFor(() => expect(screen.queryByTestId('close-confirm-dialog')).toBeNull());
      await openCloseDialog();
      await screen.findByText('No handoff: this project has no docs folder yet.');

      slowTargetOfS1.resolve(USABLE_TARGET);
      await settleRequests(fixture);

      expect(checkbox()).toBeDisabled();
      expect(checkbox()).not.toBeChecked();
    });
  });
});
