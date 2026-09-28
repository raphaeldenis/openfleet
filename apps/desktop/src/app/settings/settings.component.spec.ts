import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import { SettingsComponent } from './settings.component';

const MODEL_TABLE = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' };

async function renderSettings(models: () => Promise<unknown> = () => Promise.resolve(MODEL_TABLE)) {
  return render(SettingsComponent, { providers: [{ provide: FleetApiService, useValue: { models: vi.fn(models) } }] });
}

describe('SettingsComponent', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('offers only the Models and Daemon tabs, Models first', async () => {
    await renderSettings();

    const tabNames = screen.getAllByRole('tab').map((tab) => tab.textContent?.trim());

    expect(tabNames).toEqual(['Models', 'Daemon']);
  });

  it('shows the four rungs with their resolved model ids on the Models tab', async () => {
    await renderSettings();

    const rungIds = Object.fromEntries(
      await Promise.all(
        Object.keys(MODEL_TABLE).map(async (rung) => [rung, (await screen.findByTestId(`model-row-${rung}`)).textContent] as const),
      ),
    );

    expect(rungIds['haiku']).toContain('claude-haiku-4-5');
    expect(rungIds['sonnet']).toContain('claude-sonnet-5');
    expect(rungIds['opus']).toContain('claude-opus-5-5');
    expect(rungIds['fable']).toContain('claude-fable-5-1');
    expect(screen.getAllByTestId(/^model-row-/)).toHaveLength(4);
  });

  it('follows a stored api url for the daemon address instead of a hand-typed literal', async () => {
    localStorage.setItem('openfleet.apiUrl', 'http://127.0.0.1:7332');
    await renderSettings();

    await userEvent.click(screen.getByRole('tab', { name: 'Daemon' }));

    expect(screen.getByTestId('daemon-address')).toHaveTextContent('127.0.0.1:7332');
  });

  it('reports the admin token as not found when none is stored', async () => {
    await renderSettings();

    await userEvent.click(screen.getByRole('tab', { name: 'Daemon' }));

    expect(screen.getByTestId('admin-token-status')).toHaveTextContent(/^not found$/);
  });
});
