import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_VERSION_READER } from '../core/app-version';
import { SupportActions } from '../core/support-actions';
import { SettingsComponent } from './settings.component';

function fakeSupportActions({ isAvailable }: { isAvailable: boolean }) {
  return { isAvailable, revealLogs: vi.fn(() => Promise.resolve()), reportIssue: vi.fn(() => Promise.resolve()) };
}

async function openAboutTab(support: ReturnType<typeof fakeSupportActions>) {
  await render(SettingsComponent, {
    providers: [
      { provide: APP_VERSION_READER, useValue: () => Promise.resolve('0.2.0') },
      { provide: SupportActions, useValue: support },
    ],
  });
  await userEvent.click(screen.getByRole('tab', { name: 'About' }));
}

const revealLogsButton = () => screen.getByRole('button', { name: 'Reveal logs' });
const reportIssueButton = () => screen.getByRole('button', { name: 'Report an issue' });

describe('Settings → About → support actions', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}')))));
  afterEach(() => vi.unstubAllGlobals());

  it('reveals the logs when the desktop app offers it', async () => {
    const support = fakeSupportActions({ isAvailable: true });
    await openAboutTab(support);

    await userEvent.click(revealLogsButton());

    expect(revealLogsButton()).toBeEnabled();
    expect(support.revealLogs).toHaveBeenCalledOnce();
    expect(support.reportIssue).not.toHaveBeenCalled();
  });

  it('opens the issue report when the desktop app offers it', async () => {
    const support = fakeSupportActions({ isAvailable: true });
    await openAboutTab(support);

    await userEvent.click(reportIssueButton());

    expect(reportIssueButton()).toBeEnabled();
    expect(support.reportIssue).toHaveBeenCalledOnce();
    expect(support.revealLogs).not.toHaveBeenCalled();
  });

  it('disables both buttons outside the desktop app and says why', async () => {
    const support = fakeSupportActions({ isAvailable: false });
    await openAboutTab(support);

    await userEvent.click(revealLogsButton());
    await userEvent.click(reportIssueButton());

    expect(revealLogsButton()).toBeDisabled();
    expect(reportIssueButton()).toBeDisabled();
    expect(revealLogsButton()).toHaveAttribute('title', 'Available in the OpenFleet desktop app');
    expect(reportIssueButton()).toHaveAttribute('title', 'Available in the OpenFleet desktop app');
    expect(support.revealLogs).not.toHaveBeenCalled();
    expect(support.reportIssue).not.toHaveBeenCalled();
  });

  it('shows no error before anything failed', async () => {
    await openAboutTab(fakeSupportActions({ isAvailable: true }));

    expect(screen.queryByTestId('about-support-error')).not.toBeInTheDocument();
  });

  it('says the logs folder could not be opened when revealing fails', async () => {
    const support = fakeSupportActions({ isAvailable: true });
    support.revealLogs.mockRejectedValueOnce(new Error('no finder'));
    await openAboutTab(support);

    await userEvent.click(revealLogsButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('✕ Couldn’t open the logs folder.');
    expect(screen.getByTestId('about-support-error')).toBeInTheDocument();
  });

  it('says the issue form could not be opened when reporting fails', async () => {
    const support = fakeSupportActions({ isAvailable: true });
    support.reportIssue.mockRejectedValueOnce(new Error('no browser'));
    await openAboutTab(support);

    await userEvent.click(reportIssueButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('✕ Couldn’t open the issue form.');
  });

  it('clears the error once the next attempt works', async () => {
    const support = fakeSupportActions({ isAvailable: true });
    support.revealLogs.mockRejectedValueOnce(new Error('no finder'));
    await openAboutTab(support);
    await userEvent.click(revealLogsButton());
    await screen.findByRole('alert');

    await userEvent.click(revealLogsButton());

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
