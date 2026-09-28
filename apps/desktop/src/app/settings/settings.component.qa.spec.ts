import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import { SettingsComponent } from './settings.component';

const MODEL_TABLE = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' };
const ADMIN_TOKEN = 'sekrit-token-3f9a';

async function renderSettings(models: () => Promise<unknown> = () => Promise.resolve(MODEL_TABLE)) {
  const modelsSpy = vi.fn(models);
  const view = await render(SettingsComponent, { providers: [{ provide: FleetApiService, useValue: { models: modelsSpy } }] });
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

    expect(screen.getByTestId('model-row-haiku')).toHaveTextContent('claude-haiku-4-5');
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

  it('declares the vertical layout of its tab list to assistive tech', async () => {
    await renderSettings();

    expect(screen.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
  });

  // Major (a11y, settings.component.ts:26): the tab list has no accessible name.
  it.fails('names the tab list for screen readers', async () => {
    await renderSettings();

    expect(screen.getByRole('tablist', { name: /settings/i })).toBeTruthy();
  });

  // Major (a11y, settings.component.ts:28-33): role="tab" without a matching role="tabpanel" wired by
  // aria-controls / aria-labelledby, so a screen reader announces tabs that control nothing.
  it.fails('wires the selected tab to a tabpanel through aria-controls and aria-labelledby', async () => {
    await renderSettings();

    const panelId = modelsTab().getAttribute('aria-controls');
    const panel = panelId ? document.getElementById(panelId) : null;

    expect(panel).toHaveAttribute('role', 'tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', modelsTab().id);
  });

  // Minor (a11y, settings.component.ts:28): every tab is a Tab stop; the APG pattern keeps only the selected tab in the
  // tab sequence (roving tabindex) so Tab leaves the tab list in one press.
  it.fails('keeps only the selected tab in the Tab sequence', async () => {
    await renderSettings();

    expect(modelsTab()).toHaveAttribute('tabindex', '0');
    expect(daemonTab()).toHaveAttribute('tabindex', '-1');
  });

  // Major (a11y, settings.component.ts:28): role="tab" promises arrow-key navigation; the list is vertical so
  // ArrowDown/ArrowUp move between tabs, wrapping. There is no keydown handler at all.
  it.fails('moves selection and focus to the next tab on ArrowDown', async () => {
    await renderSettings();
    modelsTab().focus();

    await userEvent.keyboard('{ArrowDown}');

    expect(daemonTab()).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(daemonTab());
  });

  it.fails('wraps from the first tab to the last on ArrowUp', async () => {
    await renderSettings();
    modelsTab().focus();

    await userEvent.keyboard('{ArrowUp}');

    expect(document.activeElement).toBe(daemonTab());
  });

  it.fails('jumps to the last tab on End and back to the first on Home', async () => {
    await renderSettings();
    modelsTab().focus();

    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(daemonTab());

    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(modelsTab());
  });
});

describe('SettingsComponent — Models tab', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

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

  it('offers no editing control of any kind inside the model table', async () => {
    await renderSettings();
    await screen.findByTestId('model-row-haiku');

    const editingControls = screen.getByTestId('settings-models').querySelectorAll('input, textarea, select, button, [contenteditable], [role="combobox"], [role="textbox"]');

    expect(editingControls).toHaveLength(0);
  });

  it('names the file to edit in visible text, not only in a hover tooltip', async () => {
    await renderSettings();
    await screen.findByTestId('model-row-haiku');

    expect(screen.getByTestId('models-edit-hint')).toHaveTextContent('~/.openfleet/config.json');
  });

  it('shows Loading… while the daemon has not answered yet, and no table', async () => {
    await renderSettings(() => new Promise(() => {}));

    expect(screen.getByTestId('models-loading')).toBeTruthy();
    expect(screen.queryByTestId('model-row-haiku')).toBeNull();
    expect(screen.queryByTestId('models-error')).toBeNull();
  });

  it('replaces Loading… with the error, leaving no spinner behind, when the daemon is unreachable', async () => {
    await renderSettings(() => Promise.reject(new TypeError('Failed to fetch')));

    expect(await screen.findByTestId('models-error')).toHaveTextContent(/couldn.t load the model table/i);
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

  it('reads the table from the daemon with GET /api/models and the stored admin token as bearer, then shows the error on a 401', async () => {
    localStorage.setItem('openfleet.adminToken', ADMIN_TOKEN);
    const fetchStub = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchStub);

    await render(SettingsComponent);

    expect(await screen.findByTestId('models-error')).toBeTruthy();
    const [requestedUrl, requestInit] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(requestedUrl).toBe('http://127.0.0.1:7331/api/models');
    expect(requestInit.method ?? 'GET').toBe('GET');
    expect(requestInit.headers).toMatchObject({ authorization: `Bearer ${ADMIN_TOKEN}` });
  });

  it('shows the error, not a table, when the real service hits a daemon that refuses the connection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await render(SettingsComponent);

    expect(await screen.findByTestId('models-error')).toBeTruthy();
    expect(screen.queryByTestId('models-loading')).toBeNull();
  });

  // Minor (settings.component.ts:35): the error paragraph is not a live region, so a screen-reader user who
  // opens Settings against a dead daemon is never told the load failed.
  it.fails('announces the load failure to assistive tech', async () => {
    await renderSettings(() => Promise.reject(new Error('down')));

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t load/i);
  });

  // Minor (settings.component.ts:37): a 200 whose body is JSON `null` keeps modelTable() falsy, so the
  // Loading… branch renders forever — the endless spinner the error state exists to prevent.
  it.fails('leaves Loading… once the daemon answered, even when the body is not a table', async () => {
    await renderSettings(() => Promise.resolve(null));

    await vi.waitFor(() => expect(screen.queryByTestId('models-loading')).toBeNull());
  });

  // Minor (settings.component.ts:42): a body missing a rung renders an empty id cell as if it were a value.
  it.fails('never renders an empty model id cell for a rung the daemon did not send', async () => {
    await renderSettings(() => Promise.resolve({ haiku: 'claude-haiku-4-5' }));
    await screen.findByTestId('model-row-haiku');

    const sonnetId = screen.getByTestId('model-row-sonnet').querySelector('.value')?.textContent?.trim();

    expect(sonnetId).toBeTruthy();
  });
});

describe('SettingsComponent — Daemon tab', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('never puts a single character of the admin token anywhere in the document, on either tab', async () => {
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
    expect(screen.getByTestId('admin-token-status')).toHaveTextContent('found');
  });

  it('exposes the token status in no title, aria-label, aria-description or value attribute', async () => {
    localStorage.setItem('openfleet.adminToken', ADMIN_TOKEN);
    await renderSettings();
    await openDaemonTab();

    const attributeValues = Array.from(document.querySelectorAll('*')).flatMap((element) => Array.from(element.attributes).map((attribute) => attribute.value));

    expect(attributeValues.join('\n')).not.toMatch(/sekrit|3f9a/);
    expect(document.querySelectorAll('input, textarea')).toHaveLength(0);
  });

  it('reports not found when the stored token is the empty string', async () => {
    localStorage.setItem('openfleet.adminToken', '');
    await renderSettings();

    await openDaemonTab();

    expect(screen.getByTestId('admin-token-status')).toHaveTextContent('not found');
  });

  // Minor (settings.component.ts:96): `!== ''` counts a whitespace-only value as a token. The status says "found"
  // while every request sends `Bearer    ` and the daemon answers 401.
  it.fails.each([['spaces', '   '], ['a newline', '\n'], ['a tab and a space', '\t ']])('reports not found when the stored token is only %s', async (_label, blankToken) => {
    localStorage.setItem('openfleet.adminToken', blankToken);
    await renderSettings();

    await openDaemonTab();

    expect(screen.getByTestId('admin-token-status')).toHaveTextContent('not found');
  });

  it('shows the default address, not the garbage, when the stored api url has no http(s) scheme', async () => {
    localStorage.setItem('openfleet.apiUrl', 'localhost:9999');
    await renderSettings();

    await openDaemonTab();

    expect(screen.getByTestId('daemon-address')).toHaveTextContent('127.0.0.1:7331');
    expect(screen.getByTestId('daemon-address').textContent).not.toContain('9999');
  });

  it('shows the default address when the stored api url is blank', async () => {
    localStorage.setItem('openfleet.apiUrl', '   ');
    await renderSettings();

    await openDaemonTab();

    expect(screen.getByTestId('daemon-address')).toHaveTextContent('127.0.0.1:7331');
  });

  it('keeps the path prefix of a stored api url and drops its trailing slash and scheme', async () => {
    localStorage.setItem('openfleet.apiUrl', 'http://127.0.0.1:7331/openfleet/');
    await renderSettings();

    await openDaemonTab();

    expect(screen.getByTestId('daemon-address').textContent?.trim()).toBe('127.0.0.1:7331/openfleet');
  });

  // Minor (settings.component.ts:56): the "Local only" caption is hard-coded, so a stored https://daemon.example
  // url is shown, scheme stripped, under a caption that says it is local.
  it.fails('does not caption a remote https daemon address as "Local only"', async () => {
    localStorage.setItem('openfleet.apiUrl', 'https://daemon.example.com:7331');
    await renderSettings();

    await openDaemonTab();

    expect(screen.getByTestId('daemon-address')).toHaveTextContent('daemon.example.com:7331');
    expect(screen.getByTestId('settings-daemon').textContent).not.toContain('Local only');
  });
});
