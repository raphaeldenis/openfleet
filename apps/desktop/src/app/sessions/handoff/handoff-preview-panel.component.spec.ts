import { inputBinding, outputBinding } from '@angular/core';
import type { HandoffContent, HandoffSectionSource } from '@openfleet/shared';
import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HandoffPreviewState } from './handoff-preview.store';
import { HandoffPreviewPanelComponent } from './handoff-preview-panel.component';

const SECTIONS: HandoffContent = {
  goal: 'Ship the panel',
  state: 'generating',
  decisions: 'Plain class store',
  filesTouched: ' M panel.ts',
  nextSteps: '- wire the host',
  openQuestions: 'Which icon?',
};

const SOURCES: Record<keyof HandoffContent, HandoffSectionSource> = {
  goal: 'none',
  state: 'session',
  decisions: 'none',
  filesTouched: 'git',
  nextSteps: 'working_state',
  openQuestions: 'none',
};

const RELATIVE_PATH = 'handoffs/2026-10-04-gimli.md';

interface PanelOptions {
  state?: HandoffPreviewState;
  error?: string;
  saveDisabledReason?: string;
  density?: 'compact' | 'roomy';
  sections?: HandoffContent;
  metaText?: string;
  subject?: 'session' | 'manager';
}

async function renderPanel(options: PanelOptions = {}) {
  const outputs = {
    save: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
    autoClose: vi.fn(),
    openSaved: vi.fn(),
    sectionsChange: vi.fn(),
  };
  await render(HandoffPreviewPanelComponent, {
    bindings: [
      inputBinding('state', () => options.state ?? 'ready'),
      inputBinding('relativePath', () => RELATIVE_PATH),
      inputBinding('sections', () => options.sections ?? SECTIONS),
      inputBinding('sources', () => SOURCES),
      inputBinding('metaText', () => options.metaText ?? 'From the state panel and git status · edit before saving'),
      inputBinding('error', () => options.error),
      inputBinding('saveDisabledReason', () => options.saveDisabledReason),
      inputBinding('density', () => options.density ?? 'compact'),
      inputBinding('subject', () => options.subject ?? 'session'),
      outputBinding('save', outputs.save),
      outputBinding('cancel', outputs.cancel),
      outputBinding('retry', outputs.retry),
      outputBinding('autoClose', outputs.autoClose),
      outputBinding('openSaved', outputs.openSaved),
      outputBinding('sectionsChange', outputs.sectionsChange),
    ],
  });
  return outputs;
}

const SECTION_LABELS = ['Goal', 'State', 'Decisions', 'Files touched', 'Next steps', 'Open questions'];

describe('HandoffPreviewPanelComponent', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('structure and accessibility', () => {
    it('is a non-modal dialog named by its title', async () => {
      await renderPanel();

      const dialog = screen.getByRole('dialog', { name: 'Handoff preview' });
      expect(dialog).toHaveAttribute('aria-modal', 'false');
    });

    it('moves focus to the title when it opens', async () => {
      await renderPanel();

      expect(screen.getByText('Handoff preview')).toHaveFocus();
    });

    it('shows the target path chip and the meta text', async () => {
      await renderPanel();

      expect(screen.getByText(`→ ${RELATIVE_PATH}`)).toBeInTheDocument();
      expect(screen.getByText('From the state panel and git status · edit before saving')).toBeInTheDocument();
    });

    it('always has a polite status region, even when nothing is announced', async () => {
      await renderPanel();

      const status = screen.getByRole('status');
      expect(status).toHaveAttribute('aria-live', 'polite');
      expect(status.textContent?.trim()).toBe('');
    });

    it('offers Save handoff and Cancel', async () => {
      await renderPanel();

      expect(screen.getByRole('button', { name: 'Save handoff' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    it('density is exposed to the host styling through the panel', async () => {
      await renderPanel({ density: 'roomy' });

      expect(screen.getByRole('dialog')).toHaveAttribute('data-density', 'roomy');
    });
  });

  describe('sections', () => {
    it('renders the six labelled fields with their text', async () => {
      await renderPanel();

      for (const label of SECTION_LABELS) {
        expect(screen.getByRole('textbox', { name: label })).toBeInTheDocument();
      }
      expect(screen.getByRole('textbox', { name: 'Files touched' })).toHaveValue(' M panel.ts');
    });

    it('tells where each section comes from', async () => {
      await renderPanel();

      expect(screen.getByRole('textbox', { name: 'Files touched' })).toHaveAccessibleDescription('from git');
      expect(screen.getByRole('textbox', { name: 'Goal' })).toHaveAccessibleDescription('write it here');
    });

    it('names the state panel as the source of a section the session wrote itself', async () => {
      await renderPanel();

      expect(screen.getByRole('textbox', { name: 'State' })).toHaveAccessibleDescription('from the state panel');
    });

    it.each([
      ['Goal', 'What this session was for'],
      ['State', 'Where things stand'],
      ['Decisions', 'Choices made and why'],
      ['Files touched', 'Changed files'],
      ['Next steps', 'What the next session should do first'],
      ['Open questions', 'Anything unresolved'],
    ])('hints at what to write in %s', async (label, placeholder) => {
      await renderPanel({ sections: { goal: '', state: '', decisions: '', filesTouched: '', nextSteps: '', openQuestions: '' } });

      expect(screen.getByRole('textbox', { name: label })).toHaveAttribute('placeholder', placeholder);
    });

    it('asks what a manager was for when the panel belongs to a manager', async () => {
      await renderPanel({ subject: 'manager' });

      expect(screen.getByRole('textbox', { name: 'Goal' })).toHaveAttribute('placeholder', 'What this manager was for');
    });

    it('emits all six sections with the edited one changed', async () => {
      const { sectionsChange } = await renderPanel();

      await userEvent.type(screen.getByRole('textbox', { name: 'Decisions' }), '!');

      expect(sectionsChange).toHaveBeenLastCalledWith({ ...SECTIONS, decisions: 'Plain class store!' });
    });
  });

  describe('loading', () => {
    it('announces that the state is being collected and shows no fields', async () => {
      await renderPanel({ state: 'loading' });

      expect(screen.getByRole('status')).toHaveTextContent('Collecting the state…');
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('keeps the spinner out of the accessibility tree', async () => {
      await renderPanel({ state: 'loading' });

      expect(screen.getByTestId('handoff-spinner')).toHaveAttribute('aria-hidden', 'true');
    });

    it('cannot be saved yet', async () => {
      const { save } = await renderPanel({ state: 'loading' });

      await userEvent.click(screen.getByRole('button', { name: 'Save handoff' }));

      expect(save).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Save handoff' })).toHaveAttribute('aria-disabled', 'true');
    });
  });

  describe('ready', () => {
    it('emits save when Save handoff is pressed', async () => {
      const { save } = await renderPanel();

      await userEvent.click(screen.getByRole('button', { name: 'Save handoff' }));

      expect(save).toHaveBeenCalledTimes(1);
    });

    it('emits cancel when Cancel is pressed', async () => {
      const { cancel } = await renderPanel();

      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('emits cancel on Escape', async () => {
      const { cancel } = await renderPanel();

      await userEvent.keyboard('{Escape}');

      expect(cancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('save disabled with a reason', () => {
    const REASON = 'Save is off: this project has no docs folder yet.';

    it('shows the reason, links it to the Save button and does not emit save', async () => {
      const { save } = await renderPanel({ saveDisabledReason: REASON });

      const saveButton = screen.getByRole('button', { name: 'Save handoff' });
      await userEvent.click(saveButton);

      expect(saveButton).toHaveAttribute('aria-disabled', 'true');
      expect(saveButton).toHaveAccessibleDescription(REASON);
      expect(save).not.toHaveBeenCalled();
    });

    it('still shows the preview fields', async () => {
      await renderPanel({ saveDisabledReason: REASON });

      expect(screen.getAllByRole('textbox')).toHaveLength(6);
    });

    it('has no description on Save when there is no reason', async () => {
      await renderPanel();

      expect(screen.getByRole('button', { name: 'Save handoff' })).not.toHaveAccessibleDescription();
    });
  });

  describe('saving', () => {
    it('announces Saving…, keeps Save focusable (aria-disabled, not disabled) and ignores clicks', async () => {
      const { save } = await renderPanel({ state: 'saving' });

      const saveButton = screen.getByRole('button', { name: 'Saving…' });
      await userEvent.click(saveButton);

      expect(screen.getByRole('status')).toHaveTextContent('Saving…');
      expect(saveButton).toHaveAttribute('aria-disabled', 'true');
      expect(saveButton).not.toBeDisabled();
      expect(save).not.toHaveBeenCalled();
    });

    it('does not close on Escape', async () => {
      const { cancel } = await renderPanel({ state: 'saving' });

      await userEvent.keyboard('{Escape}');

      expect(cancel).not.toHaveBeenCalled();
    });

    it('locks the fields so edits cannot diverge from what is being saved', async () => {
      await renderPanel({ state: 'saving' });

      expect(screen.getByRole('textbox', { name: 'Goal' })).toBeDisabled();
    });
  });

  describe('saved', () => {
    it('announces where the handoff was saved and shows Saved ✓', async () => {
      await renderPanel({ state: 'saved' });

      expect(screen.getByRole('status')).toHaveTextContent(`Saved to ${RELATIVE_PATH}`);
      expect(screen.getByRole('button', { name: 'Saved ✓' })).toHaveAttribute('aria-disabled', 'true');
    });

    it('replaces the meta text by a link to the saved handoffs in Notes', async () => {
      const { openSaved } = await renderPanel({ state: 'saved' });

      await userEvent.click(screen.getByRole('button', { name: 'Saved · open in Notes › handoffs' }));

      expect(openSaved).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('From the state panel and git status · edit before saving')).not.toBeInTheDocument();
    });

    it('asks the host to close after two seconds', async () => {
      vi.useFakeTimers();
      const { autoClose } = await renderPanel({ state: 'saved' });

      vi.advanceTimersByTime(1999);
      expect(autoClose).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);

      expect(autoClose).toHaveBeenCalledTimes(1);
    });

    it('does not ask the host to close in any other state', async () => {
      vi.useFakeTimers();
      const { autoClose } = await renderPanel({ state: 'ready' });

      vi.advanceTimersByTime(10_000);

      expect(autoClose).not.toHaveBeenCalled();
    });

    it('still closes on Escape', async () => {
      const { cancel } = await renderPanel({ state: 'saved' });

      await userEvent.keyboard('{Escape}');

      expect(cancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('error', () => {
    const ERROR = 'The handoff was not written — the docs folder is not writable – fix the folder, then try again.';

    it('shows the error as an alert with a compact Try again and keeps the edited fields', async () => {
      await renderPanel({ state: 'error', error: ERROR, sections: { ...SECTIONS, goal: 'My edit' } });

      expect(screen.getByRole('alert')).toHaveTextContent(ERROR);
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Goal' })).toHaveValue('My edit');
    });

    it('emits retry when Try again is pressed', async () => {
      const { retry } = await renderPanel({ state: 'error', error: ERROR });

      await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

      expect(retry).toHaveBeenCalledTimes(1);
    });

    it('keeps the fields editable and Save available', async () => {
      const { save } = await renderPanel({ state: 'error', error: ERROR });

      await userEvent.click(screen.getByRole('button', { name: 'Save handoff' }));

      expect(screen.getByRole('textbox', { name: 'Goal' })).toBeEnabled();
      expect(save).toHaveBeenCalledTimes(1);
    });

    it('has no alert when there is no error', async () => {
      await renderPanel();

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('loadFailed', () => {
    const LOAD_ERROR = 'The preview could not be loaded — the daemon did not answer in time.';

    it('shows the error with Try again, no fields and no Save', async () => {
      await renderPanel({ state: 'loadFailed', error: LOAD_ERROR });

      expect(screen.getByRole('alert')).toHaveTextContent(LOAD_ERROR);
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save handoff' })).not.toBeInTheDocument();
    });

    it('emits retry and can still be cancelled', async () => {
      const { retry, cancel } = await renderPanel({ state: 'loadFailed', error: LOAD_ERROR });

      await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(retry).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
    });
  });
});
