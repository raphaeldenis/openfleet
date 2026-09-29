import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, outputBinding } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { NoteConflictBannerComponent } from './note-conflict-banner.component';

type Resolution = 'mine' | 'theirs' | 'merge' | 'restore';

async function renderBanner(overrides: { author?: string; restoreRev?: number } = {}) {
  const resolve = vi.fn<(resolution: Resolution) => void>();
  await render(NoteConflictBannerComponent, {
    bindings: [
      inputBinding('restoreRev', () => overrides.restoreRev ?? null),
      inputBinding('ours', () => 'Retry with exponential backoff from 500 ms to 30 s.'),
      inputBinding('theirs', () => ({ author: overrides.author ?? 'Nori · T7', at: '14:08', body: 'Retry with jitter and replay missed events.' })),
      outputBinding<Resolution>('resolve', resolve),
    ],
  });
  return { resolve };
}

describe('NoteConflictBannerComponent', () => {
  it('user sees both versions side by side with the other author named', async () => {
    await renderBanner();

    expect(screen.getByTestId('note-conflict-ours')).toHaveTextContent('Retry with exponential backoff from 500 ms to 30 s.');
    expect(screen.getByTestId('note-conflict-theirs')).toHaveTextContent('Nori · T7');
    expect(screen.getByTestId('note-conflict-theirs')).toHaveTextContent('Retry with jitter and replay missed events.');
  });

  it('user can keep their own version', async () => {
    const { resolve } = await renderBanner();

    await userEvent.click(screen.getByTestId('note-conflict-keep-mine'));

    expect(resolve).toHaveBeenCalledExactlyOnceWith('mine');
  });

  it('user can take the other version', async () => {
    const { resolve } = await renderBanner();

    await userEvent.click(screen.getByTestId('note-conflict-take-theirs'));

    expect(resolve).toHaveBeenCalledExactlyOnceWith('theirs');
  });

  it('user can merge both versions', async () => {
    const { resolve } = await renderBanner();

    await userEvent.click(screen.getByTestId('note-conflict-merge'));

    expect(resolve).toHaveBeenCalledExactlyOnceWith('merge');
  });

  it('user can keep the current note, which cancels the restore', async () => {
    const { resolve } = await renderBanner({ restoreRev: 4 });

    await userEvent.click(screen.getByTestId('note-conflict-keep-current'));

    expect(resolve).toHaveBeenCalledExactlyOnceWith('theirs');
  });

  it('a conflict raised by a restore offers only keeping the current note or restoring anyway', async () => {
    await renderBanner({ restoreRev: 4 });

    expect(screen.getByTestId('note-conflict-keep-current')).toHaveTextContent('Keep current');
    expect(screen.getByTestId('note-conflict-restore')).toHaveTextContent('Restore rev 4 anyway');
    expect(screen.queryByTestId('note-conflict-merge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('note-conflict-keep-mine')).not.toBeInTheDocument();
    expect(screen.queryByTestId('note-conflict-take-theirs')).not.toBeInTheDocument();
  });

  it('a conflict raised by a restore says what each choice does to the other editor’s save', async () => {
    await renderBanner({ restoreRev: 4, author: 'Nori · T7' });

    const message = screen.getByTestId('note-conflict-message');
    expect(message).toHaveTextContent('Nori · T7 saved this note while you were restoring rev 4');
    expect(message).toHaveTextContent('Keep current cancels the restore and writes nothing');
    expect(message).toHaveTextContent('Restore rev 4 anyway replaces Nori · T7’s save with rev 4');
    expect(message).not.toHaveTextContent('nothing is lost');
  });

  it('a restore that conflicts with the user’s own save says “your own save”, never “You’s”', async () => {
    await renderBanner({ restoreRev: 4, author: 'You' });

    const message = screen.getByTestId('note-conflict-message');
    expect(message).toHaveTextContent('Restore rev 4 anyway replaces your own save with rev 4');
    expect(message).not.toHaveTextContent('You’s');
  });

  it('an edit that conflicts with the user’s own save offers “Take your other save”, never “Take You’s”', async () => {
    await renderBanner({ author: 'You' });

    expect(screen.getByTestId('note-conflict-take-theirs')).toHaveTextContent('Take your other save');
    expect(screen.getByTestId('note-conflict-message')).not.toHaveTextContent('You’s');
  });

  it('user can scroll each version with the keyboard when it is long', async () => {
    await renderBanner();

    expect(screen.getByTestId('note-conflict-ours')).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('note-conflict-theirs')).toHaveAttribute('tabindex', '0');
  });

  // Class contracts: jsdom does no layout; the live QA re-measures scrollWidth and the visible height.
  it('each version has its own readable height with scrolling, so neither hides the other', async () => {
    await renderBanner();

    for (const testId of ['note-conflict-ours', 'note-conflict-theirs']) {
      const style = getComputedStyle(screen.getByTestId(testId));
      expect(style.maxHeight).toMatch(/rem$/);
      expect(style.overflow).toBe('auto');
    }
  });

  it('a very long word wraps instead of widening the banner', async () => {
    await renderBanner();

    for (const testId of ['note-conflict-message', 'note-conflict-ours', 'note-conflict-theirs']) {
      expect(getComputedStyle(screen.getByTestId(testId)).overflowWrap).toBe('anywhere');
    }
  });

  it('a conflict raised by an edit calls the user’s choice “Keep mine”', async () => {
    await renderBanner();

    expect(screen.getByTestId('note-conflict-keep-mine')).toHaveTextContent('Keep mine');
  });

  it('the conflict banner takes the focus when it appears', async () => {
    await renderBanner();

    expect(screen.getByTestId('note-conflict-bar')).toHaveFocus();
  });

  it('user can restore the version they were restoring on top of the latest revision', async () => {
    const { resolve } = await renderBanner({ restoreRev: 4 });

    await userEvent.click(screen.getByTestId('note-conflict-restore'));

    expect(screen.getByTestId('note-conflict-restore')).toHaveTextContent('Restore rev 4');
    expect(resolve).toHaveBeenCalledExactlyOnceWith('restore');
  });

  it('a conflict raised by restoring rev 0 still offers to keep the current note or restore anyway', async () => {
    await renderBanner({ restoreRev: 0 });

    expect(screen.getByTestId('note-conflict-restore')).toHaveTextContent('Restore rev 0 anyway');
    expect(screen.queryByTestId('note-conflict-keep-mine')).not.toBeInTheDocument();
  });

  it('a conflict that is not about a restore offers no restore choice', async () => {
    await renderBanner();

    expect(screen.queryByTestId('note-conflict-restore')).not.toBeInTheDocument();
  });

  it('a conflict with the file on disk names the disk instead of an agent', async () => {
    await renderBanner({ author: 'disk' });

    expect(screen.getByTestId('note-conflict-message')).toHaveTextContent('changed on disk');
    expect(screen.getByTestId('note-conflict-take-theirs')).toHaveTextContent('Keep disk');
  });
});
