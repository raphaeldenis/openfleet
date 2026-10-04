import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_SETTLE_MS, SettingsComponent } from './settings.component';

const MODEL_TABLE = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' };
const AVAILABLE_MODELS = ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1'];

interface FakeDaemon {
  table?: Record<string, string>;
  availableModels?: () => Promise<unknown>;
}

// A daemon behind a stubbed fetch: the component is exercised through the REST calls it really sends.
async function renderSettings(daemon: FakeDaemon = {}) {
  const servedTable = { ...(daemon.table ?? MODEL_TABLE) };
  const saveModels = async (patch: Record<string, string>) => {
    Object.assign(servedTable, patch);
    return { models: { ...servedTable } };
  };
  const fetchStub = vi.fn((url: string, init?: RequestInit) => {
    const { pathname } = new URL(url);
    const answer =
      init?.method === 'PUT' ? saveModels(JSON.parse(String(init.body))) :
      pathname === '/api/models/available' ? (daemon.availableModels ?? (() => Promise.resolve({ models: AVAILABLE_MODELS })))() :
      Promise.resolve({ ...servedTable });
    return answer.then((body) => new Response(JSON.stringify(body)));
  });
  vi.stubGlobal('fetch', fetchStub);
  const view = await render(SettingsComponent, { providers: [{ provide: MODEL_SETTLE_MS, useValue: 20 }] });
  const putRequests = () =>
    fetchStub.mock.calls.filter(([, init]) => init?.method === 'PUT').map(([url, init]) => ({ pathname: new URL(url).pathname, body: JSON.parse(String(init?.body)) as unknown }));
  return { ...view, servedTable, putRequests };
}

async function findRungSelect(rung: string) {
  return (await screen.findByTestId(`model-select-${rung}`)) as HTMLSelectElement;
}

function optionValuesOf(select: HTMLSelectElement) {
  return Array.from(select.options).map((option) => option.value);
}

describe('SettingsComponent', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('offers the Models, Daemon, Diagnostics and About tabs, Models first', async () => {
    await renderSettings();

    const tabNames = screen.getAllByRole('tab').map((tab) => tab.textContent?.trim());

    expect(tabNames).toEqual(['Models', 'Daemon', 'Diagnostics', 'About']);
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
    await renderSettings({ table: { ...MODEL_TABLE, opus: 'my-private-opus' } });

    const opusSelect = await findRungSelect('opus');

    expect(opusSelect.value).toBe('my-private-opus');
    expect(optionValuesOf(opusSelect)).toContain('my-private-opus');
  });

  it('sends one PUT to the models endpoint carrying only the rung that was changed', async () => {
    const { putRequests } = await renderSettings();
    const opusSelect = await findRungSelect('opus');

    await userEvent.selectOptions(opusSelect, 'claude-haiku-4-5-20251001');

    await screen.findByText(/saved opus/i);
    expect(putRequests()).toEqual([{ pathname: '/api/models', body: { opus: 'claude-haiku-4-5-20251001' } }]);
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
