import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsComponent } from './settings.component';

// Hostile black-box specs for the editable model rungs: what the user sees and what the component sends.

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

// A daemon behind a stubbed fetch: the component is exercised through the REST calls it really sends.
async function renderSettings(daemon: FakeDaemon = {}) {
  const table = { ...(daemon.table ?? MODEL_TABLE) };
  const saveModels =
    daemon.saveModels ??
    ((patch: Record<string, string>) => {
      Object.assign(table, patch);
      return Promise.resolve({ models: { ...table }, unknownRungs: [] } satisfies SavedTable);
    });
  const fetchStub = vi.fn((url: string, init?: RequestInit) => {
    const { pathname } = new URL(url);
    const answer =
      init?.method === 'PUT' ? saveModels(JSON.parse(String(init.body))) :
      pathname === '/api/models/available' ? (daemon.availableModels ?? (() => Promise.resolve({ models: AVAILABLE_MODELS })))() :
      Promise.resolve({ ...table });
    return answer.then((body) => new Response(JSON.stringify(body)));
  });
  vi.stubGlobal('fetch', fetchStub);
  const view = await render(SettingsComponent);
  const putBodies = () => fetchStub.mock.calls.filter(([, init]) => init?.method === 'PUT').map(([, init]) => JSON.parse(String(init?.body)) as unknown);
  return { ...view, putBodies };
}

const findSelect = async (rung: string) => (await screen.findByTestId(`model-select-${rung}`)) as HTMLSelectElement;
const optionValuesOf = (select: HTMLSelectElement) => Array.from(select.options).map((option) => option.value);
const openTab = (name: 'Models' | 'Daemon') => userEvent.click(screen.getByRole('tab', { name }));

afterEach(() => vi.unstubAllGlobals());

describe('SettingsComponent models — saving under stress', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('saves two rungs one after the other, one single-rung payload each, and shows both new ids', async () => {
    const { putBodies } = await renderSettings();

    await userEvent.selectOptions(await findSelect('opus'), 'claude-opus-9');
    await screen.findByText(/saved opus/i);
    await userEvent.selectOptions(await findSelect('haiku'), 'claude-sonnet-5');
    await screen.findByText(/saved haiku/i);

    expect(putBodies()).toEqual([{ opus: 'claude-opus-9' }, { haiku: 'claude-sonnet-5' }]);
    expect((await findSelect('opus')).value).toBe('claude-opus-9');
    expect((await findSelect('haiku')).value).toBe('claude-sonnet-5');
  });

  it('sends nothing while the first save is still pending and another dropdown is touched', async () => {
    const firstSave = deferred<SavedTable>();
    const { putBodies } = await renderSettings({ saveModels: () => firstSave.promise });
    await userEvent.selectOptions(await findSelect('opus'), 'claude-opus-9');

    await userEvent.selectOptions(await findSelect('haiku'), 'claude-sonnet-5');

    expect(putBodies()).toHaveLength(1);
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

    expect(await screen.findByText(/saved haiku/i)).toBeTruthy();
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
    expect(await screen.findByText(/saved opus/i)).toBeTruthy();
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

  it('keeps the dropdown that was just changed usable by keyboard while its save is pending', async () => {
    await renderSettings({ saveModels: () => new Promise(() => {}) });
    const opusSelect = await findSelect('opus');
    opusSelect.focus();

    await userEvent.selectOptions(opusSelect, 'claude-opus-9');

    expect(opusSelect).toBeEnabled();
    expect(document.activeElement).toBe(opusSelect);
  });

  it('reports a save as saved, and keeps the new id shown, when the daemon answers without unknownRungs', async () => {
    await renderSettings({ saveModels: (patch) => Promise.resolve({ models: { ...MODEL_TABLE, ...patch } }) });

    await userEvent.selectOptions(await findSelect('opus'), 'claude-opus-9');

    expect(await screen.findByText(/saved opus/i)).toBeTruthy();
    expect(screen.queryByTestId('models-save-error')).toBeNull();
    expect((await findSelect('opus')).value).toBe('claude-opus-9');
  });

  it('announces a known save and then an unknown-id save through the same live region', async () => {
    let unknownRungs: string[] = [];
    await renderSettings({ saveModels: (patch) => Promise.resolve({ models: { ...MODEL_TABLE, ...patch }, unknownRungs }) });
    await userEvent.selectOptions(await findSelect('opus'), 'claude-opus-9');
    await screen.findByText(/saved opus/i);
    const liveRegionAfterKnownSave = screen.getByRole('status');

    unknownRungs = ['haiku'];
    await userEvent.selectOptions(await findSelect('haiku'), 'claude-sonnet-5');

    await screen.findByText(/not in the known model list/i);
    expect(screen.getByRole('status')).toBe(liveRegionAfterKnownSave);
  });
});
