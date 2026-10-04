import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_VERSION_READER } from '../core/app-version';
import { type DaemonHealth, VersionsService } from '../core/versions.service';
import { SettingsComponent } from './settings.component';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function openAboutTab({ appVersion }: { appVersion: Promise<string> }) {
  await render(SettingsComponent, { providers: [{ provide: APP_VERSION_READER, useValue: () => appVersion }] });
  await userEvent.click(screen.getByRole('tab', { name: 'About' }));
}

const daemonAnswersBootCheckWith = (health: DaemonHealth) => TestBed.inject(VersionsService).recordDaemonHealth(health);
const daemonVersionShown = () => screen.getByTestId('about-daemon-version');
const appVersionShown = () => screen.getByTestId('about-app-version');

describe('Settings → About', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}')))));
  afterEach(() => vi.unstubAllGlobals());

  it('lists About as the last settings tab', async () => {
    await render(SettingsComponent, { providers: [{ provide: APP_VERSION_READER, useValue: () => Promise.resolve('0.2.0') }] });

    const tabNames = screen.getAllByRole('tab').map((tab) => tab.textContent?.trim());

    expect(tabNames).toEqual(['General', 'Models', 'Daemon', 'Diagnostics', 'About']);
  });

  async function renderOnRouteTab(tab: string) {
    const route = { queryParamMap: of(convertToParamMap({ tab })) };
    await render(SettingsComponent, {
      providers: [
        { provide: APP_VERSION_READER, useValue: () => Promise.resolve('0.2.0') },
        { provide: ActivatedRoute, useValue: route },
      ],
    });
  }

  it.each(['General', 'Models', 'Daemon', 'Diagnostics', 'About'])('opens on %s when the route asks for its tab', async (label) => {
    await renderOnRouteTab(label.toLowerCase());

    expect(screen.getByRole('tab', { name: label })).toHaveAttribute('aria-selected', 'true');
  });

  it('stays on General when the route asks for a tab that does not exist', async () => {
    await renderOnRouteTab('nope');

    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
  });

  it.each(['permissions', 'notifications'])('has no %s section to open', async (removedTab) => {
    await renderOnRouteTab(removedTab);

    expect(screen.queryByRole('tab', { name: new RegExp(removedTab, 'i') })).toBeNull();
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows the app version and the daemon version', async () => {
    await openAboutTab({ appVersion: Promise.resolve('0.2.0') });

    daemonAnswersBootCheckWith({ version: '0.2.0-dev' });

    expect(await screen.findByText('0.2.0', { selector: '[data-testid="about-app-version"]' })).toBeInTheDocument();
    expect(await screen.findByText('0.2.0-dev', { selector: '[data-testid="about-daemon-version"]' })).toBeInTheDocument();
  });

  it('shows a placeholder while the versions are still being read', async () => {
    const appVersion = deferred<string>();

    await openAboutTab({ appVersion: appVersion.promise });

    expect(appVersionShown()).toHaveTextContent('…');
    expect(daemonVersionShown()).toHaveTextContent('…');
    appVersion.resolve('0.2.0');
    expect(await screen.findByText('0.2.0', { selector: '[data-testid="about-app-version"]' })).toBeInTheDocument();
  });

  it('says the daemon version is unknown when the daemon does not report one', async () => {
    await openAboutTab({ appVersion: Promise.resolve('0.2.0') });

    daemonAnswersBootCheckWith({});

    expect(await screen.findByText('unknown', { selector: '[data-testid="about-daemon-version"]' })).toBeInTheDocument();
  });

  it('shows the newer daemon version when a later health answer replaces the recorded one', async () => {
    await openAboutTab({ appVersion: Promise.resolve('0.2.0') });
    daemonAnswersBootCheckWith({ version: '0.1.0' });

    daemonAnswersBootCheckWith({ version: '0.2.0' });

    expect(await screen.findByText('0.2.0', { selector: '[data-testid="about-daemon-version"]' })).toBeInTheDocument();
  });

  it('caps a huge daemon version at 64 characters with an ellipsis', async () => {
    await openAboutTab({ appVersion: Promise.resolve('0.2.0') });

    daemonAnswersBootCheckWith({ version: '9'.repeat(5000) });

    expect(await screen.findByText(`${'9'.repeat(63)}…`, { selector: '[data-testid="about-daemon-version"]' })).toBeInTheDocument();
  });

  it('says the daemon version is unknown when the daemon did not answer the boot check', async () => {
    await openAboutTab({ appVersion: Promise.resolve('0.2.0') });

    daemonAnswersBootCheckWith(null);

    expect(await screen.findByText('unknown', { selector: '[data-testid="about-daemon-version"]' })).toBeInTheDocument();
  });

  it('shows the real versions with no sample marker', async () => {
    await openAboutTab({ appVersion: Promise.resolve('0.2.0') });

    daemonAnswersBootCheckWith({ version: '0.2.0' });

    await screen.findByText('0.2.0', { selector: '[data-testid="about-daemon-version"]' });
    expect(screen.getByTestId('settings-about')).not.toHaveTextContent(/sample/i);
  });

  describe('version mismatch strip', () => {
    it('shows the strip with both versions and the daemon address when the versions differ', async () => {
      await openAboutTab({ appVersion: Promise.resolve('1.2.0') });

      daemonAnswersBootCheckWith({ version: '0.9.2' });

      const strip = await screen.findByTestId('about-version-mismatch');
      expect(strip).toHaveTextContent('! Version mismatch');
      expect(strip).toHaveTextContent('The daemon on 127.0.0.1:7331 is 0.9.2, this app is 1.2.0 — restart the daemon so both match.');
      expect(within(strip).getByRole('button', { name: 'Copy details' })).toBeInTheDocument();
    });

    it('shows no strip when the versions match', async () => {
      await openAboutTab({ appVersion: Promise.resolve('0.2.0') });

      daemonAnswersBootCheckWith({ version: '0.2.0' });

      await screen.findByText('0.2.0', { selector: '[data-testid="about-daemon-version"]' });
      expect(screen.queryByTestId('about-version-mismatch')).not.toBeInTheDocument();
    });

    it('shows no strip while the daemon version is unknown', async () => {
      await openAboutTab({ appVersion: Promise.resolve('1.2.0') });

      daemonAnswersBootCheckWith(null);

      await screen.findByText('unknown', { selector: '[data-testid="about-daemon-version"]' });
      expect(screen.queryByTestId('about-version-mismatch')).not.toBeInTheDocument();
    });

    it('copies details naming both versions when Copy details is pressed', async () => {
      const writeText = vi.fn(() => Promise.resolve());
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      await openAboutTab({ appVersion: Promise.resolve('1.2.0') });
      daemonAnswersBootCheckWith({ version: '0.9.2' });

      await userEvent.click(await screen.findByRole('button', { name: 'Copy details' }));

      expect(writeText).toHaveBeenCalledOnce();
      const copied = String((writeText.mock.calls[0] as unknown[])[0]);
      expect(copied).toContain('daemon: 0.9.2');
      expect(copied).toContain('app: 1.2.0');
    });
  });
});
