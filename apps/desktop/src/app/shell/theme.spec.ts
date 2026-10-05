import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { screen, within } from '@testing-library/angular/zoneless';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetEventsService } from '../core/fleet-events.service';
import { silentWorkingStateSignals } from '../working-state/working-state-fixtures';
import { AppShellComponent } from './app-shell.component';

@Component({ selector: 'stub-home', template: '' })
class StubHomeComponent {}

const routes: Routes = [{ path: '', component: AppShellComponent, children: [{ path: '', component: StubHomeComponent }] }];

const rootTheme = () => document.documentElement.getAttribute('data-theme');

function stubSystemPrefersDark(prefersDark: boolean): void {
  vi.stubGlobal('matchMedia', () => ({ matches: prefersDark }));
}

async function mountShell(): Promise<RouterTestingHarness> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter(routes),
      { provide: FleetEventsService, useValue: { sessions: signal([]), approvals: signal([]), managers: signal([]), connected: signal(true), ...silentWorkingStateSignals() } },
    ],
  });
  return RouterTestingHarness.create('');
}

describe('Theme', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    vi.unstubAllGlobals();
  });

  it('follows a dark system preference when nothing is remembered', async () => {
    stubSystemPrefersDark(true);

    await mountShell();

    expect(rootTheme()).toBe('dark');
    expect(screen.getByRole('button', { name: '☾ Dark' })).toBeTruthy();
  });

  it('follows a light system preference when nothing is remembered', async () => {
    stubSystemPrefersDark(false);

    await mountShell();

    expect(rootTheme()).toBe('light');
  });

  it('falls back to the system preference when the remembered value is unknown', async () => {
    stubSystemPrefersDark(true);
    localStorage.setItem('openfleet.theme', 'solarized');

    await mountShell();

    expect(rootTheme()).toBe('dark');
  });

  it('switches the root theme from the sidebar footer toggle', async () => {
    stubSystemPrefersDark(false);
    const harness = await mountShell();

    screen.getByRole('button', { name: '☀ Light' }).click();
    harness.detectChanges();

    expect(rootTheme()).toBe('dark');
    expect(screen.getByRole('button', { name: '☾ Dark' })).toHaveAttribute('title', 'Switch to light theme');
  });

  it('reports the toggle as pressed only while the shown theme is dark', async () => {
    stubSystemPrefersDark(true);
    const harness = await mountShell();
    expect(screen.getByRole('button', { name: '☾ Dark' })).toHaveAttribute('aria-pressed', 'true');

    screen.getByRole('button', { name: '☾ Dark' }).click();
    harness.detectChanges();
    expect(screen.getByRole('button', { name: '☀ Light' })).toHaveAttribute('aria-pressed', 'false');

    screen.getByRole('button', { name: '☀ Light' }).click();
    harness.detectChanges();
    expect(screen.getByRole('button', { name: '☾ Dark' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the chosen theme after the app is mounted again, whatever the system prefers', async () => {
    stubSystemPrefersDark(false);
    const firstMount = await mountShell();
    screen.getByRole('button', { name: '☀ Light' }).click();
    firstMount.detectChanges();
    document.documentElement.removeAttribute('data-theme');

    await mountShell();

    expect(rootTheme()).toBe('dark');
  });

  it('offers the toggle in the sidebar footer, next to the settings gear', async () => {
    stubSystemPrefersDark(false);
    await mountShell();

    const footerToggle = within(screen.getByTestId('sidebar-footer')).getByTestId('theme-toggle');

    expect(footerToggle).toHaveTextContent('☀ Light');
  });
});
