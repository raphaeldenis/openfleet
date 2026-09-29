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

async function renderHistory() {
  const restore = vi.fn<(rev: number) => void>();
  await render(NoteHistoryComponent, {
    bindings: [inputBinding('versions', () => versions), outputBinding<number>('restore', restore)],
  });
  return { restore };
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

  it('a double click on restore restores once', async () => {
    const { restore } = await renderHistory();

    await userEvent.click(screen.getByTestId('note-history-version-2'));
    await userEvent.dblClick(screen.getByTestId('note-history-restore'));

    expect(restore).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('the selected version is marked', async () => {
    await renderHistory();

    await userEvent.click(screen.getByTestId('note-history-version-3'));

    expect(screen.getByTestId('note-history-version-3')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('note-history-version-2')).toHaveAttribute('aria-selected', 'false');
  });
});
