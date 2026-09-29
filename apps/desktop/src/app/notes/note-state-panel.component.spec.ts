import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, outputBinding } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { NotePaneState, NoteStatePanelComponent } from './note-state-panel.component';

async function renderPanel(state: NotePaneState, extra: { title?: string; reason?: string; canOpenInFinder?: boolean } = {}) {
  const retry = vi.fn<() => void>();
  const openInFinder = vi.fn<() => void>();
  const create = vi.fn<() => void>();
  await render(NoteStatePanelComponent, {
    bindings: [
      inputBinding('state', () => state),
      inputBinding('title', () => extra.title ?? ''),
      inputBinding('reason', () => extra.reason ?? ''),
      inputBinding('canOpenInFinder', () => extra.canOpenInFinder ?? true),
      outputBinding<void>('retry', retry),
      outputBinding<void>('openInFinder', openInFinder),
      outputBinding<void>('create', create),
    ],
  });
  return { retry, openInFinder, create };
}

describe('NoteStatePanelComponent', () => {
  describe('loading', () => {
    it('user sees six skeleton bars with the mockup widths, not a spinner', async () => {
      await renderPanel('loading');

      const bars = screen.getAllByTestId('note-skeleton-bar');
      expect(bars.map((bar) => bar.style.width)).toEqual(['40%', '90%', '85%', '60%', '95%', '70%']);
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });
  });

  describe('error', () => {
    const invalidFile = { title: 'daemon-protocol', reason: 'notes/daemon-protocol.md is not valid UTF-8 (byte 0x9f at offset 2310). The file is untouched.' };

    it('user sees which note failed to open and why', async () => {
      await renderPanel('error', invalidFile);

      expect(screen.getByTestId('note-error-title')).toHaveTextContent('Couldn’t open “daemon-protocol”');
      expect(screen.getByTestId('note-error-reason')).toHaveTextContent('not valid UTF-8');
    });

    it('user can retry opening the note', async () => {
      const { retry } = await renderPanel('error', invalidFile);

      await userEvent.click(screen.getByTestId('note-error-retry'));

      expect(retry).toHaveBeenCalledOnce();
    });

    it('user can reveal the note in Finder', async () => {
      const { openInFinder } = await renderPanel('error', invalidFile);

      await userEvent.click(screen.getByTestId('note-error-open-in-finder'));

      expect(openInFinder).toHaveBeenCalledOnce();
    });
  });

  describe('error without a known folder', () => {
    it('user is not offered Finder when the note has no folder on disk, but can still retry', async () => {
      await renderPanel('error', { title: 'voice', reason: 'Daemon unreachable', canOpenInFinder: false });

      expect(screen.queryByTestId('note-error-open-in-finder')).not.toBeInTheDocument();
      expect(screen.getByTestId('note-error-retry')).toBeInTheDocument();
    });
  });

  describe('empty', () => {
    it('user learns what notes are for and can create the first one', async () => {
      const { create } = await renderPanel('empty');

      expect(screen.getByTestId('note-empty-headline')).toHaveTextContent('Notes are shared memory for you and your agents');

      await userEvent.click(screen.getByTestId('note-empty-create'));

      expect(create).toHaveBeenCalledOnce();
    });
  });
});
