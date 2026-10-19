import type { Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetEventsService } from '../core/fleet-events.service';
import { NativeNotifications } from '../core/native-notifications.service';
import { ThemeService } from '../core/theme.service';
import { SettingsComponent } from './settings.component';

async function renderGeneralSection(providers: Provider[] = []) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}'))));
  return render(SettingsComponent, { providers });
}

describe('Settings → General', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('is the section Settings opens on', async () => {
    await renderGeneralSection();

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('General');
  });

  it('offers Setup with a "Run setup again →" button', async () => {
    await renderGeneralSection();

    expect(screen.getByText('Setup')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run setup again →' })).toBeEnabled();
  });

  it('opens the setup stepper, and comes back to Settings afterwards, when "Run setup again →" is pressed', async () => {
    await renderGeneralSection();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);

    await userEvent.click(screen.getByRole('button', { name: 'Run setup again →' }));

    expect(navigate).toHaveBeenCalledWith('/onboarding', { state: { returnUrl: '/settings' } });
  });

  it('says the theme is also switchable from the sidebar footer and names the current theme', async () => {
    localStorage.setItem('openfleet.theme', 'light');
    await renderGeneralSection();

    expect(screen.getByText('Also switchable from the sidebar footer')).toBeInTheDocument();
    expect(screen.getByTestId('general-theme')).toHaveTextContent('Light');
  });

  it('switches the theme through the shared theme service when the theme button is pressed', async () => {
    localStorage.setItem('openfleet.theme', 'light');
    await renderGeneralSection();

    await userEvent.click(screen.getByTestId('general-theme'));

    expect(TestBed.inject(ThemeService).theme()).toBe('dark');
    expect(screen.getByTestId('general-theme')).toHaveTextContent('Dark');
  });

  it('follows a theme switched from the sidebar footer while Settings is open', async () => {
    localStorage.setItem('openfleet.theme', 'light');
    await renderGeneralSection();

    TestBed.inject(ThemeService).toggle();

    expect(await screen.findByText('Dark', { selector: '[data-testid="general-theme"]' })).toBeInTheDocument();
  });

  it('shows the docs folder root as disabled, with the reason, because this build has no such setting', async () => {
    await renderGeneralSection();

    expect(screen.getByText('Docs folder root')).toBeInTheDocument();
    expect(screen.getByTestId('general-docs-root')).toBeDisabled();
    expect(screen.getByText(/Not configurable in this build yet/)).toBeInTheDocument();
  });

  it('shows the handoff-on-close and reply-language rows disabled, since the daemon has no such setting', async () => {
    await renderGeneralSection();

    expect(screen.getByTestId('general-handoff-on-close')).toBeDisabled();
    expect(screen.getByTestId('general-reply-language')).toBeDisabled();
  });
});

describe('Settings → General → notifications', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('offers the master switch, mute, the two live categories and the Dock badge, with the defaults on', async () => {
    await renderGeneralSection();

    expect(screen.getByRole('switch', { name: 'Notifications' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Mute' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Agent finished' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Needs input' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Dock badge' })).toBeChecked();
  });

  it('keeps a switched-off master after the page is reopened', async () => {
    const first = await renderGeneralSection();
    await userEvent.click(screen.getByRole('switch', { name: 'Notifications' }));
    first.fixture.destroy();
    TestBed.resetTestingModule();

    await renderGeneralSection();

    expect(screen.getByRole('switch', { name: 'Notifications' })).not.toBeChecked();
  });

  it('shows tool completion and chat message as unavailable', async () => {
    await renderGeneralSection();

    expect(screen.getByTestId('general-notify-tool-completion')).toBeDisabled();
    expect(screen.getByTestId('general-notify-chat-message')).toBeDisabled();
  });

  it('says where to allow notifications once the system refused them', async () => {
    const refusingNotifications = { isAvailable: true, show: async () => 'permissionDenied', setDockBadge: async () => undefined, onBannerClick: async () => () => undefined };
    await renderGeneralSection([{ provide: NativeNotifications, useValue: refusingNotifications }]);
    expect(screen.queryByTestId('notifications-permission-hint')).not.toBeInTheDocument();

    TestBed.inject(FleetEventsService).notificationTriggers.next({ category: 'agentFinished', sessionId: 's1' });

    expect(await screen.findByTestId('notifications-permission-hint', undefined, { timeout: 3000 })).toHaveTextContent('Notifications are off for OpenFleet in System Settings.');
  });
});
