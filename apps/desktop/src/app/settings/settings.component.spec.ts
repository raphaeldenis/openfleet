import { render, screen, within } from '@testing-library/angular/zoneless';
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

  it('renders the model table read-only and names the file to edit by hand', async () => {
    await renderSettings();
    await screen.findByTestId('model-row-haiku');

    const modelsPanel = screen.getByTestId('settings-models');

    expect(within(modelsPanel).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(modelsPanel).queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByTestId('models-edit-hint')).toHaveAttribute('title', expect.stringContaining('~/.openfleet/config.json'));
  });

  it('shows an inline error instead of a table when the model table cannot be loaded', async () => {
    await renderSettings(() => Promise.reject(new Error('down')));

    expect(await screen.findByTestId('models-error')).toBeTruthy();
    expect(screen.queryByTestId('model-row-haiku')).toBeNull();
  });

  it('shows the daemon address from the environment on the Daemon tab', async () => {
    await renderSettings();

    await userEvent.click(screen.getByRole('tab', { name: 'Daemon' }));

    expect(screen.getByTestId('daemon-address')).toHaveTextContent('127.0.0.1:7331');
  });

  it('follows a stored api url for the daemon address instead of a hand-typed literal', async () => {
    localStorage.setItem('openfleet.apiUrl', 'http://127.0.0.1:7332');
    await renderSettings();

    await userEvent.click(screen.getByRole('tab', { name: 'Daemon' }));

    expect(screen.getByTestId('daemon-address')).toHaveTextContent('127.0.0.1:7332');
  });

  it('reports the admin token as found without revealing any of its characters', async () => {
    localStorage.setItem('openfleet.adminToken', 'sekrit-token-3f9a');
    await renderSettings();

    await userEvent.click(screen.getByRole('tab', { name: 'Daemon' }));

    const tokenStatus = screen.getByTestId('admin-token-status');
    expect(tokenStatus).toHaveTextContent('found');
    expect(tokenStatus).not.toHaveTextContent('not found');
    expect(screen.getByTestId('settings-daemon').textContent).not.toContain('3f9a');
    expect(screen.getByTestId('settings-daemon').textContent).not.toContain('sekrit');
  });

  it('reports the admin token as not found when none is stored', async () => {
    await renderSettings();

    await userEvent.click(screen.getByRole('tab', { name: 'Daemon' }));

    expect(screen.getByTestId('admin-token-status')).toHaveTextContent('not found');
  });
});
