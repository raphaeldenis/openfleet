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

  it('a conflict raised by a restore calls the user’s choice “Keep current”, since it keeps the body from before the restore', async () => {
    await renderBanner({ restoreRev: 4 });

    expect(screen.getByTestId('note-conflict-keep-mine')).toHaveTextContent('Keep current');
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
