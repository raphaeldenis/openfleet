import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, outputBinding, signal } from '@angular/core';
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

  it('user sees an "Untitled" placeholder on a note without a title', async () => {
    await renderList({ notes: [aNoteSummary({ id: 'n7', title: '' })] });

    expect(screen.getByTestId('note-list-item-n7')).toHaveTextContent('Untitled');
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

  describe('keyboard', () => {
    const tabIndexOf = (noteId: string) => screen.getByTestId(`note-list-item-${noteId}`).getAttribute('tabindex');

    it('assistive technology reads the notes as a list of items', async () => {
      await renderList();

      expect(screen.getByTestId('note-list-items')).toHaveAttribute('role', 'list');
      expect(within(screen.getByTestId('note-list-items')).getAllByRole('listitem')).toHaveLength(3);
    });

    it('the list is a single tab stop on the first note', async () => {
      await renderList();

      expect([tabIndexOf('n1'), tabIndexOf('n2'), tabIndexOf('n3')]).toEqual(['0', '-1', '-1']);
    });

    it('the open note is the tab stop', async () => {
      await renderList({ selectedId: 'n2' });

      expect([tabIndexOf('n1'), tabIndexOf('n2'), tabIndexOf('n3')]).toEqual(['-1', '0', '-1']);
    });

    it('user moves through the notes with the arrow keys and the tab stop follows', async () => {
      await renderList();
      screen.getByTestId('note-list-item-n1').focus();

      await userEvent.keyboard('{ArrowDown}');
      expect(screen.getByTestId('note-list-item-n2')).toHaveFocus();
      expect([tabIndexOf('n1'), tabIndexOf('n2')]).toEqual(['-1', '0']);

      await userEvent.keyboard('{ArrowUp}');
      expect(screen.getByTestId('note-list-item-n1')).toHaveFocus();
    });

    it('user jumps to the first and last notes with Home and End', async () => {
      await renderList();
      screen.getByTestId('note-list-item-n2').focus();

      await userEvent.keyboard('{End}');
      expect(screen.getByTestId('note-list-item-n3')).toHaveFocus();

      await userEvent.keyboard('{Home}');
      expect(screen.getByTestId('note-list-item-n1')).toHaveFocus();
    });

    it('the arrow keys stop at both ends of the list', async () => {
      await renderList();
      screen.getByTestId('note-list-item-n3').focus();

      await userEvent.keyboard('{ArrowDown}');

      expect(screen.getByTestId('note-list-item-n3')).toHaveFocus();
    });

    it('user opens the focused note with Enter or Space', async () => {
      const { selected } = await renderList();
      screen.getByTestId('note-list-item-n2').focus();

      await userEvent.keyboard('{Enter}');
      await userEvent.keyboard(' ');

      expect(selected).toHaveBeenCalledTimes(2);
      expect(selected).toHaveBeenCalledWith('n2');
    });

    it('the open note becomes the tab stop again after focus left the list and the selection changed', async () => {
      const selectedId = signal<string | null>(null);
      await render(NoteListComponent, {
        bindings: [inputBinding('notes', () => notes), inputBinding('selectedId', selectedId)],
      });
      screen.getByTestId('note-list-item-n2').focus();

      await userEvent.click(screen.getByTestId('note-list-filter'));
      selectedId.set('n3');
      await userEvent.tab();

      expect([tabIndexOf('n1'), tabIndexOf('n2'), tabIndexOf('n3')]).toEqual(['-1', '-1', '0']);
    });

    it('the tab stop stays on the focused note while focus moves inside the list', async () => {
      await renderList({ selectedId: 'n1' });
      screen.getByTestId('note-list-item-n1').focus();

      await userEvent.keyboard('{ArrowDown}');

      expect([tabIndexOf('n1'), tabIndexOf('n2')]).toEqual(['-1', '0']);
    });

    it('a filtered list keeps one tab stop among the notes still shown', async () => {
      await renderList();

      await userEvent.type(screen.getByTestId('note-list-filter'), 'release');

      expect(tabIndexOf('n2')).toBe('0');
    });

    it('the first note still shown is the tab stop when the filter hides the open note', async () => {
      await renderList({ selectedId: 'n1' });

      await userEvent.type(screen.getByTestId('note-list-filter'), 'release');

      expect(tabIndexOf('n2')).toBe('0');
    });

    it('a note focused before focus left the list does not keep the tab stop once the open note changes', async () => {
      const selectedId = signal<string | null>('n1');
      await render(NoteListComponent, {
        bindings: [inputBinding('notes', () => notes), inputBinding('selectedId', selectedId)],
      });
      screen.getByTestId('note-list-item-n1').focus();

      await userEvent.click(screen.getByTestId('note-list-filter'));
      selectedId.set('n3');
      await userEvent.tab();

      expect([tabIndexOf('n1'), tabIndexOf('n3')]).toEqual(['-1', '0']);
    });
  });
});
