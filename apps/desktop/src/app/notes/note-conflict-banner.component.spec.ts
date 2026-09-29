import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { inputBinding, outputBinding } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { NoteConflictBannerComponent } from './note-conflict-banner.component';

type Resolution = 'mine' | 'theirs' | 'merge';

async function renderBanner(overrides: { author?: string } = {}) {
  const resolve = vi.fn<(resolution: Resolution) => void>();
  await render(NoteConflictBannerComponent, {
    bindings: [
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

  it.each([
    ['note-conflict-keep-mine', 'mine'],
    ['note-conflict-take-theirs', 'theirs'],
    ['note-conflict-merge', 'merge'],
  ])('a double click on %s resolves the conflict once', async (testId, resolution) => {
    const { resolve } = await renderBanner();

    await userEvent.dblClick(screen.getByTestId(testId));

    expect(resolve).toHaveBeenCalledExactlyOnceWith(resolution);
  });

  it('once a choice is made the other choices no longer apply', async () => {
    const { resolve } = await renderBanner();

    await userEvent.click(screen.getByTestId('note-conflict-keep-mine'));
    await userEvent.click(screen.getByTestId('note-conflict-take-theirs'));

    expect(resolve).toHaveBeenCalledExactlyOnceWith('mine');
  });

  it('a conflict with the file on disk names the disk instead of an agent', async () => {
    await renderBanner({ author: 'disk' });

    expect(screen.getByTestId('note-conflict-message')).toHaveTextContent('changed on disk');
    expect(screen.getByTestId('note-conflict-take-theirs')).toHaveTextContent('Keep disk');
  });
});
