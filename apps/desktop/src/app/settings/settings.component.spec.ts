import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import { SettingsComponent } from './settings.component';

const MODEL_TABLE = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' };
const AVAILABLE_MODELS = ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5', 'claude-fable-5-1'];

interface FakeDaemon {
  models?: () => Promise<unknown>;
  availableModels?: () => Promise<unknown>;
  saveModels?: (patch: Record<string, string>) => Promise<unknown>;
}

async function renderSettings(daemon: FakeDaemon = {}) {
  const api = {
    models: vi.fn(daemon.models ?? (() => Promise.resolve(MODEL_TABLE))),
    availableModels: vi.fn(daemon.availableModels ?? (() => Promise.resolve({ models: AVAILABLE_MODELS }))),
    saveModels: vi.fn(daemon.saveModels ?? ((patch: Record<string, string>) => Promise.resolve({ models: { ...MODEL_TABLE, ...patch }, unknownRungs: [] }))),
  };
  const view = await render(SettingsComponent, { providers: [{ provide: FleetApiService, useValue: api }] });
  return { ...view, api };
}

async function findRungSelect(rung: string) {
  return (await screen.findByTestId(`model-select-${rung}`)) as HTMLSelectElement;
}

function optionValuesOf(select: HTMLSelectElement) {
  return Array.from(select.options).map((option) => option.value);
}

describe('SettingsComponent', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('offers only the Models and Daemon tabs, Models first', async () => {
    await renderSettings();

    const tabNames = screen.getAllByRole('tab').map((tab) => tab.textContent?.trim());

    expect(tabNames).toEqual(['Models', 'Daemon']);
  });

  it('shows one dropdown per rung, each preselected on its current model id', async () => {
    await renderSettings();

    const selectedIds = Object.fromEntries(
      await Promise.all(Object.keys(MODEL_TABLE).map(async (rung) => [rung, (await findRungSelect(rung)).value] as const)),
    );

    expect(selectedIds).toEqual(MODEL_TABLE);
    expect(screen.getAllByTestId(/^model-row-/)).toHaveLength(4);
  });

  it('offers every model the daemon lists in each rung dropdown', async () => {
    await renderSettings();

    for (const rung of Object.keys(MODEL_TABLE)) {
      expect(optionValuesOf(await findRungSelect(rung))).toEqual(expect.arrayContaining(AVAILABLE_MODELS));
    }
  });

  it('keeps a configured id that is not in the daemon list selectable instead of blanking the dropdown', async () => {
    await renderSettings({ models: () => Promise.resolve({ ...MODEL_TABLE, opus: 'my-private-opus' }) });

    const opusSelect = await findRungSelect('opus');

    expect(opusSelect.value).toBe('my-private-opus');
    expect(optionValuesOf(opusSelect)).toContain('my-private-opus');
  });

  it('still shows the current ids when the daemon cannot list the available models', async () => {
    await renderSettings({ availableModels: () => Promise.reject(new Error('down')) });

    expect((await findRungSelect('sonnet')).value).toBe('claude-sonnet-5');
  });

  it('saves only the rung that was changed, with the chosen id', async () => {
    const { api } = await renderSettings();
    const opusSelect = await findRungSelect('opus');

    await userEvent.selectOptions(opusSelect, 'claude-fable-5');

    expect(api.saveModels).toHaveBeenCalledTimes(1);
    expect(api.saveModels).toHaveBeenCalledWith({ opus: 'claude-fable-5' });
  });

  it('confirms the save and keeps the new id selected', async () => {
    await renderSettings();

    await userEvent.selectOptions(await findRungSelect('opus'), 'claude-fable-5');

    expect(await screen.findByTestId('models-save-status')).toHaveTextContent(/saved/i);
    expect((await findRungSelect('opus')).value).toBe('claude-fable-5');
  });

  it('warns when the daemon saved an id it does not know', async () => {
    await renderSettings({ saveModels: (patch) => Promise.resolve({ models: { ...MODEL_TABLE, ...patch }, unknownRungs: ['opus'] }) });

    await userEvent.selectOptions(await findRungSelect('opus'), 'claude-fable-5');

    expect(await screen.findByTestId('models-save-status')).toHaveTextContent(/not in the known model list/i);
  });

  it('announces a failed save and puts the dropdown back on the previous id', async () => {
    await renderSettings({ saveModels: () => Promise.reject(new Error('500')) });

    await userEvent.selectOptions(await findRungSelect('opus'), 'claude-fable-5');

    expect(await screen.findByTestId('models-save-error')).toHaveTextContent(/couldn.t save/i);
    expect((await findRungSelect('opus')).value).toBe('claude-opus-5-5');
  });

  it('disables the dropdowns while a save is in flight so two saves cannot overlap', async () => {
    await renderSettings({ saveModels: () => new Promise(() => {}) });

    await userEvent.selectOptions(await findRungSelect('opus'), 'claude-fable-5');

    for (const rung of Object.keys(MODEL_TABLE)) {
      expect(await findRungSelect(rung)).toBeDisabled();
    }
  });

  it('tells the user a change reaches new sessions only and running sessions keep their model', async () => {
    await renderSettings();
    await findRungSelect('haiku');

    const note = screen.getByTestId('models-edit-hint');

    expect(note).toHaveTextContent(/new sessions/i);
    expect(note).toHaveTextContent(/running sessions keep/i);
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
