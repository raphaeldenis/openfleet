import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, outputBinding } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { NoteHistoryComponent } from './note-history.component';
import { aNoteVersion } from './notes.fixtures';

const versions = [
  aNoteVersion({ id: 'v3', rev: 3, author: 'Nori · T7', createdAt: new Date(Date.now() - 2 * 60_000).toISOString() }),
  aNoteVersion({ id: 'v2', rev: 2, author: 'You' }),
  aNoteVersion({ id: 'v1', rev: 1, author: 'Argus' }),
];

async function renderHistory(options: { isRestoreBlocked?: boolean; currentRev?: number; error?: string } = {}) {
  const restore = vi.fn<(rev: number) => void>();
  const retry = vi.fn<() => void>();
  await render(NoteHistoryComponent, {
    bindings: [
      inputBinding('versions', () => versions),
      inputBinding('isRestoreBlocked', () => options.isRestoreBlocked ?? false),
      inputBinding('currentRev', () => options.currentRev ?? null),
      inputBinding('error', () => options.error ?? ''),
      outputBinding<number>('restore', restore),
      outputBinding<void>('retry', retry),
    ],
  });
  return { restore, retry };
}

describe('NoteHistoryComponent', () => {
  it('user sees each version with its author, revision and age', async () => {
    await renderHistory();

    const newest = screen.getByTestId('note-history-version-3');
    expect(newest).toHaveTextContent('Nori · T7');
    expect(newest).toHaveTextContent('rev 3');
    expect(newest).toHaveTextContent('2 min ago');
  });

  it('user sees the newest version first even though the daemon lists it last', async () => {
    await renderHistory();

    const revisions = screen.getAllByTestId(/^note-history-version-/).map((row) => row.dataset['testid']);
    expect(revisions).toEqual(['note-history-version-3', 'note-history-version-2', 'note-history-version-1']);
  });

  it('user cannot restore before choosing a version', async () => {
    await renderHistory();

    expect(screen.getByTestId('note-history-restore')).toBeDisabled();
  });

  it('user can restore the version they selected', async () => {
    const { restore } = await renderHistory();

    await userEvent.click(screen.getByTestId('note-history-version-2'));
    await userEvent.click(screen.getByTestId('note-history-restore'));

    expect(restore).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('user cannot restore again while a restore is running', async () => {
    const { restore } = await renderHistory({ isRestoreBlocked: true });

    await userEvent.click(screen.getByTestId('note-history-version-2'));
    await userEvent.click(screen.getByTestId('note-history-restore'));

    expect(screen.getByTestId('note-history-restore')).toBeDisabled();
    expect(restore).not.toHaveBeenCalled();
  });

  it('user cannot restore the revision the note is already at', async () => {
    await renderHistory({ currentRev: 3 });

    await userEvent.click(screen.getByTestId('note-history-version-3'));

    expect(screen.getByTestId('note-history-restore')).toBeDisabled();
  });

  it('user can restore an older revision than the current one', async () => {
    await renderHistory({ currentRev: 3 });

    await userEvent.click(screen.getByTestId('note-history-version-2'));

    expect(screen.getByTestId('note-history-restore')).toBeEnabled();
  });

  it('the selected version is marked as pressed', async () => {
    await renderHistory();

    await userEvent.click(screen.getByTestId('note-history-version-3'));

    expect(screen.getByTestId('note-history-version-3')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('note-history-version-2')).toHaveAttribute('aria-pressed', 'false');
  });

  it('user sees why the history could not be loaded and can retry', async () => {
    const { retry } = await renderHistory({ error: 'GET versions → 500' });

    expect(screen.getByTestId('note-history-error')).toHaveTextContent('GET versions → 500');
    await userEvent.click(screen.getByTestId('note-history-retry'));

    expect(retry).toHaveBeenCalledOnce();
  });

  it('no error is shown when the history loaded', async () => {
    await renderHistory();

    expect(screen.queryByTestId('note-history-error')).not.toBeInTheDocument();
  });
});
