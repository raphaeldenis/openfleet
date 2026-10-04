import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeService } from '../core/theme.service';
import { SettingsComponent } from './settings.component';

async function renderGeneralSection() {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}'))));
  return render(SettingsComponent);
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

  it('says the theme follows the toolbar toggle and names the current theme', async () => {
    localStorage.setItem('openfleet.theme', 'light');
    await renderGeneralSection();

    expect(screen.getByText('Follows the toolbar toggle')).toBeInTheDocument();
    expect(screen.getByTestId('general-theme')).toHaveTextContent('Light');
  });

  it('switches the theme through the shared theme service when the theme button is pressed', async () => {
    localStorage.setItem('openfleet.theme', 'light');
    await renderGeneralSection();

    await userEvent.click(screen.getByTestId('general-theme'));

    expect(TestBed.inject(ThemeService).theme()).toBe('dark');
    expect(screen.getByTestId('general-theme')).toHaveTextContent('Dark');
  });

  it('follows a theme switched from the toolbar while Settings is open', async () => {
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

  it('offers no handoff or language row, since the daemon has no such setting', async () => {
    await renderGeneralSection();

    expect(screen.queryByText(/Write a handoff when a session closes/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Agents reply and write in/)).not.toBeInTheDocument();
  });
});
