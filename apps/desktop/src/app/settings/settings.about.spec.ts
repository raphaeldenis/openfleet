import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { render, screen } from '@testing-library/angular/zoneless';
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

    expect(tabNames).toEqual(['Models', 'Daemon', 'About']);
  });

  it('opens on About when the route asks for tab=about', async () => {
    const route = { queryParamMap: of(convertToParamMap({ tab: 'about' })) };
    await render(SettingsComponent, {
      providers: [
        { provide: APP_VERSION_READER, useValue: () => Promise.resolve('0.2.0') },
        { provide: ActivatedRoute, useValue: route },
      ],
    });

    expect(screen.getByRole('tab', { name: 'About' })).toHaveAttribute('aria-selected', 'true');
  });

  it('stays on Models when the route asks for a tab that does not exist', async () => {
    const route = { queryParamMap: of(convertToParamMap({ tab: 'nope' })) };
    await render(SettingsComponent, {
      providers: [
        { provide: APP_VERSION_READER, useValue: () => Promise.resolve('0.2.0') },
        { provide: ActivatedRoute, useValue: route },
      ],
    });

    expect(screen.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true');
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
});
