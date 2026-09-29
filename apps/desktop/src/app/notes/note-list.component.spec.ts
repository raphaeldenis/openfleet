import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, outputBinding } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { NoteListComponent } from './note-list.component';
import { aNoteSummary } from './notes.fixtures';
import type { NoteSummary } from '@openfleet/shared';

const notes = [
  aNoteSummary({ id: 'n1', title: 'daemon-protocol' }),
  aNoteSummary({ id: 'n2', title: 'release-checklist' }),
  aNoteSummary({ id: 'n3', title: 'voice' }),
];

async function renderList(overrides: { notes?: NoteSummary[]; selectedId?: string | null } = {}) {
  const selected = vi.fn<(id: string) => void>();
  const create = vi.fn<() => void>();
  await render(NoteListComponent, {
    bindings: [
      inputBinding('notes', () => overrides.notes ?? notes),
      inputBinding('selectedId', () => overrides.selectedId ?? null),
      outputBinding<string>('selected', selected),
      outputBinding<void>('create', create),
    ],
  });
  return { selected, create };
}

describe('NoteListComponent', () => {
  it('user sees every note title in the list', async () => {
    await renderList();

    expect(screen.getByTestId('note-list-item-n1')).toHaveTextContent('daemon-protocol');
    expect(screen.getByTestId('note-list-item-n2')).toHaveTextContent('release-checklist');
    expect(screen.getByTestId('note-list-item-n3')).toHaveTextContent('voice');
  });

  it('user sees when each note was last updated', async () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60_000).toISOString();
    await renderList({ notes: [aNoteSummary({ id: 'n1', updatedAt: twoMinutesAgo })] });

    expect(screen.getByTestId('note-list-item-n1')).toHaveTextContent('2 min ago');
  });

  it('user can open a note by clicking it', async () => {
    const { selected } = await renderList();

    await userEvent.click(screen.getByTestId('note-list-item-n2'));

    expect(selected).toHaveBeenCalledExactlyOnceWith('n2');
  });

  it('the open note is marked as current', async () => {
    await renderList({ selectedId: 'n2' });

    expect(screen.getByTestId('note-list-item-n2')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('note-list-item-n1')).not.toHaveAttribute('aria-current');
  });

  it('user can narrow the list by typing in the filter', async () => {
    await renderList();

    await userEvent.type(screen.getByTestId('note-list-filter'), 'release');

    expect(screen.getByTestId('note-list-item-n2')).toBeInTheDocument();
    expect(screen.queryByTestId('note-list-item-n1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('note-list-item-n3')).not.toBeInTheDocument();
  });

  it('user is told when the filter matches nothing', async () => {
    await renderList();

    await userEvent.type(screen.getByTestId('note-list-filter'), 'zzz');

    expect(screen.getByTestId('note-list-no-match')).toBeInTheDocument();
  });

  it('user can start a new note with the plus button', async () => {
    const { create } = await renderList();

    await userEvent.click(screen.getByTestId('note-list-new'));

    expect(create).toHaveBeenCalledOnce();
  });

  it('user sees "No notes yet." when there are no notes', async () => {
    await renderList({ notes: [] });

    expect(screen.getByTestId('note-list-empty')).toHaveTextContent('No notes yet.');
  });
});
