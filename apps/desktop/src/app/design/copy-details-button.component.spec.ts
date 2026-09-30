import { inputBinding } from '@angular/core';
import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyDetailsButtonComponent } from './copy-details-button.component';

const CONFIRMATION_MS = 2000;

async function renderButton() {
  const { fixture } = await render(CopyDetailsButtonComponent, { bindings: [inputBinding('text', () => 'ref 3f9a1c2e'), inputBinding('testId', () => 'copy')] });
  const button = screen.getByTestId('copy');
  const settle = () => fixture.detectChanges();
  return { button, settle };
}

function stubClipboard(writeText: () => Promise<void>) {
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
}

describe('CopyDetailsButtonComponent', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('says Copied, and announces it politely, once the text is on the clipboard', async () => {
    stubClipboard(() => Promise.resolve());
    const { button, settle } = await renderButton();

    await userEvent.click(button);

    await vi.waitFor(() => {
      settle();
      expect(button).toHaveTextContent('Copied');
      expect(screen.getByRole('status')).toHaveTextContent('Copied');
    });
  });

  it('says Copy failed when the clipboard rejects', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')));
    const { button, settle } = await renderButton();

    await userEvent.click(button);

    await vi.waitFor(() => {
      settle();
      expect(button).toHaveTextContent('Copy failed');
      expect(screen.getByRole('status')).toHaveTextContent('Copy failed');
    });
  });

  it('says Copy failed, with no unhandled rejection, when the page has no clipboard', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    const { button, settle } = await renderButton();

    await userEvent.click(button);

    await vi.waitFor(() => {
      settle();
      expect(button).toHaveTextContent('Copy failed');
    });
  });

  it('goes back to Copy details after the confirmation delay', async () => {
    stubClipboard(() => Promise.resolve());
    const { button, settle } = await renderButton();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await userEvent.click(button);
    await vi.waitFor(() => {
      settle();
      expect(button).toHaveTextContent('Copied');
    });
    vi.advanceTimersByTime(CONFIRMATION_MS);

    await vi.waitFor(() => {
      settle();
      expect(button).toHaveTextContent('Copy details');
    });
  });

  it('keeps the confirmation for a full delay after the latest of two overlapping clicks', async () => {
    stubClipboard(() => Promise.resolve());
    const { button, settle } = await renderButton();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await userEvent.click(button);
    await vi.waitFor(() => {
      settle();
      expect(button).toHaveTextContent('Copied');
    });
    vi.advanceTimersByTime(CONFIRMATION_MS - 500);
    await userEvent.click(button);
    vi.advanceTimersByTime(CONFIRMATION_MS - 500);
    settle();

    expect(button).toHaveTextContent('Copied');
  });
});
