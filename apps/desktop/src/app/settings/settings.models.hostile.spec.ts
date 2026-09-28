import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import { SettingsComponent } from './settings.component';

// Hostile black-box specs for the editable model rungs: what the user sees and what the component sends.
// `it.fails` marks a proven defect (the assertion states the correct behaviour and currently does not hold);
// each carries its severity and production file:line. Fix the code, then flip `it.fails` to `it`.

const MODEL_TABLE = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' };
const AVAILABLE_MODELS = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-9'];

type SavedTable = { models: Record<string, string>; unknownRungs: string[] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface FakeDaemon {
  table?: Record<string, string>;
  availableModels?: () => Promise<unknown>;
  saveModels?: (patch: Record<string, string>) => Promise<unknown>;
}

async function renderSettings(daemon: FakeDaemon = {}) {
  const table = { ...(daemon.table ?? MODEL_TABLE) };
  const api = {
    models: vi.fn(() => Promise.resolve({ ...table })),
    availableModels: vi.fn(daemon.availableModels ?? (() => Promise.resolve({ models: AVAILABLE_MODELS }))),
    saveModels: vi.fn(
      daemon.saveModels ??
        ((patch: Record<string, string>) => {
          Object.assign(table, patch);
          return Promise.resolve({ models: { ...table }, unknownRungs: [] } satisfies SavedTable);
        }),
    ),
  };
  const view = await render(SettingsComponent, { providers: [{ provide: FleetApiService, useValue: api }] });
  return { ...view, api };
}

const findSelect = async (rung: string) => (await screen.findByTestId(`model-select-${rung}`)) as HTMLSelectElement;
const optionValuesOf = (select: HTMLSelectElement) => Array.from(select.options).map((option) => option.value);
const openTab = (name: 'Models' | 'Daemon') => userEvent.click(screen.getByRole('tab', { name }));

describe('SettingsComponent models — saving under stress', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('saves two rungs one after the other, one single-rung payload each, and shows both new ids', async () => {
    const { api } = await renderSettings();

    await userEvent.selectOptions(await findSelect('opus'), 'claude-opus-9');
    await screen.findByTestId('models-save-status');
    await userEvent.selectOptions(await findSelect('haiku'), 'claude-sonnet-5');

    expect(api.saveModels.mock.calls).toEqual([[{ opus: 'claude-opus-9' }], [{ haiku: 'claude-sonnet-5' }]]);
    expect((await findSelect('opus')).value).toBe('claude-opus-9');
    expect((await findSelect('haiku')).value).toBe('claude-sonnet-5');
  });

  it('sends nothing while the first save is still pending and another dropdown is touched', async () => {
    const firstSave = deferred<SavedTable>();
    const { api } = await renderSettings({ saveModels: () => firstSave.promise });
    await userEvent.selectOptions(await findSelect('opus'), 'claude-opus-9');

    await userEvent.selectOptions(await findSelect('haiku'), 'claude-sonnet-5').catch(() => undefined);

    expect(api.saveModels).toHaveBeenCalledTimes(1);
    expect((await findSelect('haiku')).value).toBe('claude-haiku-4-5');
    firstSave.resolve({ models: { ...MODEL_TABLE, opus: 'claude-opus-9' }, unknownRungs: [] });
  });

  it('puts an id the daemon does not list back on its dropdown when the save fails', async () => {
    await renderSettings({ table: { ...MODEL_TABLE, opus: 'my-private-opus' }, saveModels: () => Promise.reject(new Error('500')) });

    await userEvent.selectOptions(await findSelect('opus'), 'claude-opus-9');

    expect(await screen.findByTestId('models-save-error')).toBeTruthy();
    expect((await findSelect('opus')).value).toBe('my-private-opus');
  });

  it('puts the dash back on a rung the daemon never sent when its first save fails', async () => {
    await renderSettings({ table: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5-5' }, saveModels: () => Promise.reject(new Error('500')) });

    await userEvent.selectOptions(await findSelect('fable'), 'claude-fable-5-1');

    expect(await screen.findByTestId('models-save-error')).toBeTruthy();
    expect((await findSelect('fable')).value).toBe('');
  });

  it('clears the failure notice once the next save works, and names the rung that failed while it shows', async () => {
    let shouldFail = true;
    await renderSettings({
      saveModels: (patch) => (shouldFail ? Promise.reject(new Error('500')) : Promise.resolve({ models: { ...MODEL_TABLE, ...patch }, unknownRungs: [] })),
    });
    await userEvent.selectOptions(await findSelect('opus'), 'claude-opus-9');
    expect(await screen.findByTestId('models-save-error')).toHaveTextContent(/opus/);

    shouldFail = false;
    await userEvent.selectOptions(await findSelect('haiku'), 'claude-sonnet-5');

    expect(await screen.findByTestId('models-save-status')).toHaveTextContent(/saved haiku/i);
    expect(screen.queryByTestId('models-save-error')).toBeNull();
  });

  it('enables every dropdown again after a failed save', async () => {
    await renderSettings({ saveModels: () => Promise.reject(new Error('500')) });

    await userEvent.selectOptions(await findSelect('opus'), 'claude-opus-9');
    await screen.findByTestId('models-save-error');

    for (const rung of Object.keys(MODEL_TABLE)) expect(await findSelect(rung)).toBeEnabled();
  });
});

describe('SettingsComponent models — leaving mid-save', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('shows the previous id and the failure when the save fails while the user is on the Daemon tab', async () => {
    const pendingSave = deferred<SavedTable>();
    await renderSettings({ saveModels: () => pendingSave.promise });
    await userEvent.selectOptions(await findSelect('opus'), 'claude-opus-9');
    await openTab('Daemon');

    pendingSave.reject(new Error('500'));
    await openTab('Models');

    expect(await screen.findByTestId('models-save-error')).toBeTruthy();
    expect((await findSelect('opus')).value).toBe('claude-opus-5-5');
    expect(await findSelect('opus')).toBeEnabled();
  });

  it('shows the new id when the save succeeds while the user is on the Daemon tab', async () => {
    const pendingSave = deferred<SavedTable>();
    await renderSettings({ saveModels: () => pendingSave.promise });
    await userEvent.selectOptions(await findSelect('opus'), 'claude-opus-9');
    await openTab('Daemon');

    pendingSave.resolve({ models: { ...MODEL_TABLE, opus: 'claude-opus-9' }, unknownRungs: [] });
    await openTab('Models');

    expect((await findSelect('opus')).value).toBe('claude-opus-9');
    expect(await screen.findByTestId('models-save-status')).toHaveTextContent(/saved opus/i);
  });
});

describe('SettingsComponent models — degraded lists', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it.each([
    ['rejects', () => Promise.reject(new Error('down'))],
    ['answers null', () => Promise.resolve(null)],
    ['answers without a models list', () => Promise.resolve({})],
    ['answers a models list that is not an array', () => Promise.resolve({ models: 'claude-sonnet-5' })],
  ])('still shows every current id on its own dropdown when the available list %s', async (_label, availableModels) => {
    await renderSettings({ availableModels });

    for (const [rung, currentId] of Object.entries(MODEL_TABLE)) {
      const select = await findSelect(rung);
      expect(select.value).toBe(currentId);
      expect(optionValuesOf(select)).toEqual([currentId]);
    }
  });

  it('lists the available ids once per dropdown, the current id never twice', async () => {
    await renderSettings();

    for (const rung of Object.keys(MODEL_TABLE)) {
      const optionValues = optionValuesOf(await findSelect(rung));
      expect(new Set(optionValues).size).toBe(optionValues.length);
    }
  });
});

describe('SettingsComponent models — defects', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  // Defect (minor, a11y) — settings.component.ts:68 (`[disabled]="isSavingModel()"` on every select): the
  // select the user just operated turns disabled, so a keyboard user loses the control mid-interaction
  // (a disabled control takes no key events and drops focus). Use `aria-disabled` / `aria-busy` on the group
  // instead, or keep the changed select enabled.
  it.fails('keeps the dropdown that was just changed usable by keyboard while its save is pending', async () => {
    await renderSettings({ saveModels: () => new Promise(() => {}) });
    const opusSelect = await findSelect('opus');
    opusSelect.focus();

    await userEvent.selectOptions(opusSelect, 'claude-opus-9');

    expect(opusSelect).toBeEnabled();
    expect(document.activeElement).toBe(opusSelect);
  });

  // Defect (minor) — settings.component.ts:180-182: `unknownRungs.includes(...)` throws when the answer has
  // no unknownRungs (older/other daemon). The catch then reports "couldn't save … kept the previous one" and
  // forces the dropdown back to the old id, although the daemon DID save the new one and the table signal
  // already holds it — the screen lies about the daemon's state.
  it.fails('reports a save as saved, and keeps the new id shown, when the daemon answers without unknownRungs', async () => {
    await renderSettings({ saveModels: (patch) => Promise.resolve({ models: { ...MODEL_TABLE, ...patch } }) });

    await userEvent.selectOptions(await findSelect('opus'), 'claude-opus-9');

    expect(await screen.findByTestId('models-save-status')).toHaveTextContent(/saved/i);
    expect((await findSelect('opus')).value).toBe('claude-opus-9');
  });

  // Defect (minor, a11y) — settings.component.ts:83-87: the "saved" and "unknown" notices are two different
  // <p role="status"> nodes swapped by @if/@else, so the live region is destroyed and recreated between saves;
  // assistive tech announces a region whose text changes, not one that is freshly inserted, so the unknown-id
  // warning is easily never spoken. One persistent status element whose text changes fixes it.
  it.fails('announces a known save and then an unknown-id save through the same live region', async () => {
    let unknownRungs: string[] = [];
    await renderSettings({ saveModels: (patch) => Promise.resolve({ models: { ...MODEL_TABLE, ...patch }, unknownRungs }) });
    await userEvent.selectOptions(await findSelect('opus'), 'claude-opus-9');
    const liveRegionAfterKnownSave = await screen.findByRole('status');

    unknownRungs = ['haiku'];
    await userEvent.selectOptions(await findSelect('haiku'), 'claude-sonnet-5');

    expect(await screen.findByRole('status')).toBe(liveRegionAfterKnownSave);
    expect(liveRegionAfterKnownSave).toHaveTextContent(/not in the known model list/i);
  });
});
