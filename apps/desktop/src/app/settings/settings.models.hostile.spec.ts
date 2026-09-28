import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_SETTLE_MS, SettingsComponent } from './settings.component';

// Hostile black-box specs for the editable model rungs: what the user sees and what the component sends.

const MODEL_TABLE = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' };
const AVAILABLE_MODELS = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-9'];

type SavedTable = { models: Record<string, string> };

const SETTLE_MS = 20;

class DaemonRefusal {
  constructor(readonly status: number, readonly error: string) {}
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface FakeDaemon {
  settleMs?: number;
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
      return Promise.resolve({ models: { ...table } } satisfies SavedTable);
    });
  const fetchStub = vi.fn((url: string, init?: RequestInit) => {
    const { pathname } = new URL(url);
    const answer =
      init?.method === 'PUT' ? saveModels(JSON.parse(String(init.body))) :
      pathname === '/api/models/available' ? (daemon.availableModels ?? (() => Promise.resolve({ models: AVAILABLE_MODELS })))() :
      Promise.resolve({ ...table });
    return answer.then(
      (body) => new Response(JSON.stringify(body)),
      (failure: unknown) => (failure instanceof DaemonRefusal ? new Response(JSON.stringify({ error: failure.error }), { status: failure.status }) : Promise.reject(failure)),
    );
  });
  vi.stubGlobal('fetch', fetchStub);
  const view = await render(SettingsComponent, { providers: [{ provide: MODEL_SETTLE_MS, useValue: daemon.settleMs ?? SETTLE_MS }] });
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
    await vi.waitFor(() => expect(putBodies()).toHaveLength(1));

    await userEvent.selectOptions(await findSelect('haiku'), 'claude-sonnet-5');

    expect(putBodies()).toHaveLength(1);
    expect((await findSelect('haiku')).value).toBe('claude-haiku-4-5');
    firstSave.resolve({ models: { ...MODEL_TABLE, opus: 'claude-opus-9' } });
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
      saveModels: (patch) => (shouldFail ? Promise.reject(new Error('500')) : Promise.resolve({ models: { ...MODEL_TABLE, ...patch } })),
    });
    await userEvent.selectOptions(await findSelect('opus'), 'claude-opus-9');
    expect(await screen.findByTestId('models-save-error')).toHaveTextContent(/opus/);

    shouldFail = false;
    await userEvent.selectOptions(await findSelect('haiku'), 'claude-sonnet-5');

    expect(await screen.findByText(/saved haiku/i)).toBeTruthy();
    expect(screen.queryByTestId('models-save-error')).toBeNull();
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

    pendingSave.resolve({ models: { ...MODEL_TABLE, opus: 'claude-opus-9' } });
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

  it('announces one save and then the next through the same live region', async () => {
    await renderSettings();
    await userEvent.selectOptions(await findSelect('opus'), 'claude-opus-9');
    await screen.findByText(/saved opus/i);
    const liveRegionAfterFirstSave = screen.getByRole('status');

    await userEvent.selectOptions(await findSelect('haiku'), 'claude-sonnet-5');

    await screen.findByText(/saved haiku/i);
    expect(screen.getByRole('status')).toBe(liveRegionAfterFirstSave);
  });
});

// A native select fires `change` on every ArrowDown (Win/Linux Chrome) and on every type-ahead match.
function chooseInSteps(select: HTMLSelectElement, modelIds: string[]) {
  for (const modelId of modelIds) {
    select.value = modelId;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
const waitLongerThanSettle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS * 5));

describe('SettingsComponent models — settling before saving', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('sends one save carrying only the final id when the dropdown steps through several ids', async () => {
    const { putBodies } = await renderSettings();
    const opusSelect = await findSelect('opus');

    chooseInSteps(opusSelect, ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-9']);

    await screen.findByText(/saved opus/i);
    expect(putBodies()).toEqual([{ opus: 'claude-opus-9' }]);
  });

  it('sends nothing when the dropdown steps away and lands back on the saved id', async () => {
    const { putBodies } = await renderSettings();
    const opusSelect = await findSelect('opus');

    chooseInSteps(opusSelect, ['claude-opus-9', 'claude-opus-5-5']);
    await waitLongerThanSettle();

    expect(putBodies()).toEqual([]);
  });

  it('says the change is unsaved, and sends nothing, until the user has settled', async () => {
    const { putBodies } = await renderSettings({ settleMs: 300 });
    const opusSelect = await findSelect('opus');

    chooseInSteps(opusSelect, ['claude-opus-9']);

    const announcement = await screen.findByText(/unsaved.*opus/i);
    expect(announcement).toBe(screen.getByRole('status'));
    expect(putBodies()).toEqual([]);
    await screen.findByText(/saved opus/i);
  });

  it('says the change is saving while the daemon has not answered yet', async () => {
    const pendingSave = deferred<SavedTable>();
    await renderSettings({ saveModels: () => pendingSave.promise });

    await userEvent.selectOptions(await findSelect('opus'), 'claude-opus-9');

    expect(await screen.findByText(/saving.*opus/i)).toBe(screen.getByRole('status'));
    pendingSave.resolve({ models: { ...MODEL_TABLE, opus: 'claude-opus-9' } });
  });
});

describe('SettingsComponent models — failed save card', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it.each([
    ['config.json is read-only', new DaemonRefusal(409, 'config_read_only'), /config\.json is read-only\. Your change was not applied\./i],
    ['config.json is unreadable', new DaemonRefusal(409, 'config_unreadable'), /config\.json couldn.t be read/i],
    ['the model id is refused', new DaemonRefusal(400, 'invalid_body'), /the daemon rejected this model id\./i],
    ['the daemon fails', new DaemonRefusal(500, 'internal'), /something went wrong/i],
    ['the daemon is unreachable', new TypeError('Failed to fetch'), /something went wrong/i],
  ])('explains the cause when %s', async (_label, failure, expectedCause) => {
    await renderSettings({ saveModels: () => Promise.reject(failure) });

    await userEvent.selectOptions(await findSelect('opus'), 'claude-opus-9');

    const card = await screen.findByTestId('models-save-error');
    expect(card).toHaveTextContent(/couldn.t save/i);
    expect(card).toHaveTextContent(expectedCause);
    expect(within(card).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('sends the last intended id again when Retry is pressed, and drops the card once it is saved', async () => {
    let isDaemonWritable = false;
    const { putBodies } = await renderSettings({
      saveModels: (patch) => (isDaemonWritable ? Promise.resolve({ models: { ...MODEL_TABLE, ...patch } }) : Promise.reject(new DaemonRefusal(409, 'config_read_only'))),
    });
    await userEvent.selectOptions(await findSelect('opus'), 'claude-opus-9');
    await screen.findByTestId('models-save-error');

    isDaemonWritable = true;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await screen.findByText(/saved opus/i);
    expect(putBodies()).toEqual([{ opus: 'claude-opus-9' }, { opus: 'claude-opus-9' }]);
    expect(screen.queryByTestId('models-save-error')).toBeNull();
    expect((await findSelect('opus')).value).toBe('claude-opus-9');
  });

  it('shows the intended id in the dropdown at once when Retry is pressed, while the save runs', async () => {
    const retrySave = deferred<SavedTable>();
    let isDaemonWritable = false;
    await renderSettings({ saveModels: () => (isDaemonWritable ? retrySave.promise : Promise.reject(new DaemonRefusal(409, 'config_read_only'))) });
    await userEvent.selectOptions(await findSelect('opus'), 'claude-opus-9');
    await screen.findByTestId('models-save-error');
    expect((await findSelect('opus')).value).toBe('claude-opus-5-5');

    isDaemonWritable = true;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await screen.findByText(/saving.*opus/i);
    expect((await findSelect('opus')).value).toBe('claude-opus-9');
    retrySave.resolve({ models: { ...MODEL_TABLE, opus: 'claude-opus-9' } });
  });

  it('drops the failure card as soon as the user starts another change', async () => {
    await renderSettings({ settleMs: 300, saveModels: (patch) => (patch['opus'] ? Promise.reject(new Error('500')) : Promise.resolve({ models: { ...MODEL_TABLE, ...patch } })) });
    await userEvent.selectOptions(await findSelect('opus'), 'claude-opus-9');
    await screen.findByTestId('models-save-error');

    chooseInSteps(await findSelect('haiku'), ['claude-sonnet-5']);

    await screen.findByText(/unsaved.*haiku/i);
    expect(screen.queryByTestId('models-save-error')).toBeNull();
    await screen.findByText(/saved haiku/i);
  });
});

describe('SettingsComponent models — notices never outlive their edit', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('goes quiet, instead of repeating the last "Saved", when a new edit is undone', async () => {
    await renderSettings();
    await userEvent.selectOptions(await findSelect('opus'), 'claude-opus-9');
    await screen.findByText(/saved opus/i);

    chooseInSteps(await findSelect('haiku'), ['claude-sonnet-5', 'claude-haiku-4-5']);

    await vi.waitFor(() => expect(screen.getByRole('status').textContent).toBe(''));
  });
});

describe('SettingsComponent models — leaving before the user has settled', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('sends the pending change at once when the screen is left, instead of dropping it', async () => {
    const { fixture, putBodies } = await renderSettings({ settleMs: 60_000 });
    chooseInSteps(await findSelect('opus'), ['claude-opus-9']);
    await screen.findByText(/unsaved.*opus/i);

    fixture.destroy();

    await vi.waitFor(() => expect(putBodies()).toEqual([{ opus: 'claude-opus-9' }]));
  });

  it('sends nothing when the screen is left with no pending change', async () => {
    const { fixture, putBodies } = await renderSettings({ settleMs: 60_000 });
    await findSelect('opus');

    fixture.destroy();
    await waitLongerThanSettle();

    expect(putBodies()).toEqual([]);
  });
});
