import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import { SettingsComponent } from './settings.component';

const MODEL_TABLE = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' };
const ADMIN_TOKEN = 'sekrit-token-3f9a';

async function renderSettings(models: () => Promise<unknown> = () => Promise.resolve(MODEL_TABLE)) {
  const modelsSpy = vi.fn(models);
  const api = {
    models: modelsSpy,
    availableModels: vi.fn(() => Promise.resolve({ models: Object.values(MODEL_TABLE) })),
    saveModels: vi.fn((patch: Record<string, string>) => Promise.resolve({ models: { ...MODEL_TABLE, ...patch }, unknownRungs: [] })),
  };
  const view = await render(SettingsComponent, { providers: [{ provide: FleetApiService, useValue: api }] });
  return { ...view, models: modelsSpy };
}

function modelsTab() {
  return screen.getByRole('tab', { name: 'Models' });
}

function daemonTab() {
  return screen.getByRole('tab', { name: 'Daemon' });
}

async function openDaemonTab() {
  await userEvent.click(daemonTab());
}

describe('SettingsComponent — tab bar', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('starts on Models: Models is the selected tab and Daemon is not', async () => {
    await renderSettings();

    expect(modelsTab()).toHaveAttribute('aria-selected', 'true');
    expect(daemonTab()).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('settings-models')).toBeTruthy();
    expect(screen.queryByTestId('settings-daemon')).toBeNull();
  });

  it('moves the selection and the panel together when Daemon is picked, then back again without refetching the table', async () => {
    const { models } = await renderSettings();
    await screen.findByTestId('model-row-haiku');

    await openDaemonTab();

    expect(daemonTab()).toHaveAttribute('aria-selected', 'true');
    expect(modelsTab()).toHaveAttribute('aria-selected', 'false');
    expect(screen.queryByTestId('settings-models')).toBeNull();
    expect(screen.getByTestId('settings-daemon')).toBeTruthy();

    await userEvent.click(modelsTab());

    expect(screen.getByTestId('model-select-haiku')).toHaveValue('claude-haiku-4-5');
    expect(models).toHaveBeenCalledTimes(1);
  });

  it('keeps focus on the tab that was just picked instead of dropping it to the body', async () => {
    await renderSettings();

    await openDaemonTab();

    expect(document.activeElement).toBe(daemonTab());
  });

  it('switches tab from the keyboard with Enter and with Space on a focused tab', async () => {
    await renderSettings();
    daemonTab().focus();

    await userEvent.keyboard('{Enter}');
    expect(daemonTab()).toHaveAttribute('aria-selected', 'true');

    modelsTab().focus();
    await userEvent.keyboard(' ');
    expect(modelsTab()).toHaveAttribute('aria-selected', 'true');
  });

  it('exposes a named vertical tab list whose selected tab is the only Tab stop and controls the tabpanel', async () => {
    await renderSettings();

    expect(screen.getByRole('tablist', { name: /settings/i })).toHaveAttribute('aria-orientation', 'vertical');
    expect(modelsTab()).toHaveAttribute('tabindex', '0');
    expect(daemonTab()).toHaveAttribute('tabindex', '-1');
    const panelId = modelsTab().getAttribute('aria-controls');
    const panel = panelId ? document.getElementById(panelId) : null;
    expect(panel).toHaveAttribute('role', 'tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', modelsTab().id);
  });

  it('moves selection and focus with the arrow keys, wrapping around', async () => {
    await renderSettings();
    modelsTab().focus();

    await userEvent.keyboard('{ArrowDown}');
    expect(daemonTab()).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(daemonTab());

    await userEvent.keyboard('{ArrowDown}');
    expect(modelsTab()).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(modelsTab());

    await userEvent.keyboard('{ArrowUp}');
    expect(daemonTab()).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(daemonTab());
  });

  it('leaves a modified arrow key to the browser: not swallowed, no tab change', async () => {
    await renderSettings();
    const modifiedArrow = new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true });

    modelsTab().dispatchEvent(modifiedArrow);

    expect(modifiedArrow.defaultPrevented).toBe(false);
    expect(modelsTab()).toHaveAttribute('aria-selected', 'true');
  });
});

describe('SettingsComponent — Models tab', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('lists the rungs cheapest to most capable, never more than the four it knows', async () => {
    await renderSettings(() => Promise.resolve({ ...MODEL_TABLE, gpt: 'gpt-4', secret: 'leaked-extra-key' }));
    await screen.findByTestId('model-row-haiku');

    const renderedRungOrder = screen.getAllByTestId(/^model-row-/).map((row) => row.getAttribute('data-testid'));

    expect(renderedRungOrder).toEqual(['model-row-haiku', 'model-row-sonnet', 'model-row-opus', 'model-row-fable']);
    expect(screen.getByTestId('settings-models').textContent).not.toContain('leaked-extra-key');
  });

  it('renders a model id as inert text, never as markup', async () => {
    await renderSettings(() => Promise.resolve({ ...MODEL_TABLE, opus: '<img src=x onerror="window.__pwned=1">' }));
    const opusRow = await screen.findByTestId('model-row-opus');

    expect(opusRow.querySelector('img')).toBeNull();
    expect(opusRow).toHaveTextContent('<img src=x onerror="window.__pwned=1">');
  });

  it('offers exactly four dropdowns and no free-text field inside the model table', async () => {
    await renderSettings();
    await screen.findByTestId('model-row-haiku');

    const modelsPanel = screen.getByTestId('settings-models');

    expect(within(modelsPanel).getAllByRole('combobox')).toHaveLength(4);
    expect(modelsPanel.querySelectorAll('input, textarea, [contenteditable]')).toHaveLength(0);
  });

  it('labels each dropdown with its rung name for screen readers', async () => {
    await renderSettings();
    await screen.findByTestId('model-row-haiku');

    for (const rung of ['haiku', 'sonnet', 'opus', 'fable']) {
      expect(screen.getByRole('combobox', { name: new RegExp(rung, 'i') })).toBeTruthy();
    }
  });

  it('no longer tells the user to edit the config file by hand and restart the daemon', async () => {
    await renderSettings();
    await screen.findByTestId('model-row-haiku');

    const note = screen.getByTestId('models-edit-hint');

    expect(note).not.toHaveTextContent(/by hand/i);
    expect(note).not.toHaveTextContent(/restart the daemon/i);
  });

  it('shows Loading… while the daemon has not answered yet, and no table', async () => {
    await renderSettings(() => new Promise(() => {}));

    expect(screen.getByTestId('models-loading')).toBeTruthy();
    expect(screen.queryByTestId('model-row-haiku')).toBeNull();
    expect(screen.queryByTestId('models-error')).toBeNull();
  });

  it('replaces Loading… with an announced error, and no table, when the daemon is unreachable', async () => {
    await renderSettings(() => Promise.reject(new TypeError('Failed to fetch')));

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t load the model table/i);
    expect(screen.getByTestId('models-error')).toBeTruthy();
    expect(screen.queryByTestId('models-loading')).toBeNull();
    expect(screen.queryByTestId('model-row-haiku')).toBeNull();
  });

  it('keeps the error visible after leaving and re-entering the Models tab', async () => {
    await renderSettings(() => Promise.reject(new Error('down')));
    await screen.findByTestId('models-error');

    await openDaemonTab();
    await userEvent.click(modelsTab());

    expect(screen.getByTestId('models-error')).toBeTruthy();
    expect(screen.queryByTestId('models-loading')).toBeNull();
  });

  it('shows the error, and no table or Loading…, when the daemon answers with something that is not a table', async () => {
    await renderSettings(() => Promise.resolve(null));

    expect(await screen.findByTestId('models-error')).toBeTruthy();
    expect(screen.queryByTestId('models-loading')).toBeNull();
    expect(screen.queryByTestId('model-row-haiku')).toBeNull();
  });

  it('shows a dash, never an empty cell, for a rung the daemon did not send', async () => {
    await renderSettings(() => Promise.resolve({ haiku: 'claude-haiku-4-5' }));
    await screen.findByTestId('model-row-haiku');

    expect(within(screen.getByTestId('model-row-sonnet')).getByText('—')).toBeTruthy();
  });
});

describe('SettingsComponent — Daemon tab', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('labels the token line as a stored token that is found, without revealing any of its characters, on either tab', async () => {
    localStorage.setItem('openfleet.adminToken', ADMIN_TOKEN);
    await renderSettings();
    await screen.findByTestId('model-row-haiku');
    const modelsTabMarkup = document.body.innerHTML;

    await openDaemonTab();
    const daemonTabMarkup = document.body.innerHTML;

    for (const markup of [modelsTabMarkup, daemonTabMarkup]) {
      expect(markup).not.toContain(ADMIN_TOKEN);
      expect(markup).not.toContain('sekrit');
      expect(markup).not.toContain('3f9a');
    }
    expect(screen.getByTestId('admin-token-status')).toHaveTextContent(/^found$/);
    expect(screen.getByTestId('settings-daemon')).toHaveTextContent('Stored admin token');
    expect(screen.getByTestId('settings-daemon')).not.toHaveTextContent('admin.token');
  });

  it('exposes the token status in no title, aria-label, aria-description or value attribute', async () => {
    localStorage.setItem('openfleet.adminToken', ADMIN_TOKEN);
    await renderSettings();
    await openDaemonTab();

    const attributeValues = Array.from(document.querySelectorAll('*')).flatMap((element) => Array.from(element.attributes).map((attribute) => attribute.value));

    expect(attributeValues.join('\n')).not.toMatch(/sekrit|3f9a/);
    expect(document.querySelectorAll('input, textarea')).toHaveLength(0);
  });

  it.each([['spaces', '   '], ['a newline', '\n'], ['a tab and a space', '\t ']])('reports not found when the stored token is only %s', async (_label, blankToken) => {
    localStorage.setItem('openfleet.adminToken', blankToken);
    await renderSettings();

    await openDaemonTab();

    expect(screen.getByTestId('admin-token-status')).toHaveTextContent(/^not found$/);
  });

  it.each([['localhost', 'http://localhost:7331', 'localhost:7331'], ['IPv6 loopback', 'http://[::1]:7331', '[::1]:7331']])('captions the %s address as "Local only"', async (_label, apiUrl, shownAddress) => {
    localStorage.setItem('openfleet.apiUrl', apiUrl);
    await renderSettings();

    await openDaemonTab();

    expect(screen.getByTestId('daemon-address')).toHaveTextContent(shownAddress);
    expect(screen.getByTestId('settings-daemon').textContent).toContain('Local only');
  });

  it('shows the default local daemon address and never sends the token to a stored remote https address', async () => {
    localStorage.setItem('openfleet.apiUrl', 'https://daemon.example.com:7331');
    localStorage.setItem('openfleet.adminToken', ADMIN_TOKEN);
    const fetchSpy = vi.fn((_url: string) => Promise.resolve(new Response(JSON.stringify(MODEL_TABLE))));
    vi.stubGlobal('fetch', fetchSpy);
    await render(SettingsComponent);
    await screen.findByTestId('model-row-haiku');

    await openDaemonTab();

    expect(screen.getByTestId('daemon-address')).toHaveTextContent(/^127\.0\.0\.1:7331$/);
    expect(screen.getByTestId('settings-daemon').textContent).toContain('Local only');
    const requestedUrls = fetchSpy.mock.calls.map(([url]) => String(url));
    expect(requestedUrls.length).toBeGreaterThan(0);
    expect(requestedUrls.every((url) => url.startsWith('http://127.0.0.1:7331/'))).toBe(true);
  });
});
