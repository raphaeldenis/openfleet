import type { DiagnosticsDocument } from '@openfleet/shared';
import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticsExport, type SaveBundleOutcome } from '../core/diagnostics-export';
import { DiagnosticsSettingsComponent } from './diagnostics-settings.component';

const A_DOCUMENT: DiagnosticsDocument = {
  generatedAt: '2026-10-04T10:00:00.000Z',
  version: { openfleet: '0.1.0', node: 'v26.0.0', platform: 'darwin' },
  config: { port: 7331, home: '$OPENFLEET_HOME', e2eEnabled: false },
  health: { status: 'degraded', issues: [{ code: 'db_stuck', since: 't', message: 'stuck', id: 'cccccccc', count: 1 }] },
  migrations: [],
  db: { quickCheck: 'ok', sizeBytes: 4096 },
  sessions: [],
  log: [{ level: 'error', id: 'aaaaaaaa' }, { level: 'error', id: 'bbbbbbbb' }],
};

function fakeExport(overrides: Partial<DiagnosticsExport> = {}) {
  return {
    isAvailable: true,
    readDesktopLog: vi.fn(() => Promise.resolve('desktop log line')),
    saveBundle: vi.fn((): Promise<SaveBundleOutcome> => Promise.resolve({ status: 'saved', path: '/Users/x/Desktop/bundle.zip' })),
    revealSavedBundle: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

const daemonAnswers = (document: DiagnosticsDocument) => vi.fn(() => Promise.resolve(new Response(JSON.stringify(document))));
const daemonIsSilent = () => vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));

async function renderDiagnostics(exporter: ReturnType<typeof fakeExport>) {
  await render(DiagnosticsSettingsComponent, { providers: [{ provide: DiagnosticsExport, useValue: exporter }] });
}

const exportButton = () => screen.getByTestId('diagnostics-export');
const copyButton = () => screen.getByRole('button', { name: 'Copy' });

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText } });
}

describe('Settings → Diagnostics → export bundle', () => {
  beforeEach(() => vi.stubGlobal('fetch', daemonAnswers(A_DOCUMENT)));
  afterEach(() => vi.unstubAllGlobals());

  it('starts idle: an enabled Export… button and no status line', async () => {
    await renderDiagnostics(fakeExport());

    expect(exportButton()).toHaveTextContent('Export…');
    expect(exportButton()).toBeEnabled();
    expect(screen.queryByTestId('diagnostics-saved')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows Exporting… and a busy, disabled button while the dialog is open', async () => {
    const exporter = fakeExport({ saveBundle: vi.fn(() => new Promise<SaveBundleOutcome>(() => {})) });
    await renderDiagnostics(exporter);

    await userEvent.click(exportButton());

    expect(await screen.findByRole('button', { name: 'Exporting…' })).toBeDisabled();
    expect(exportButton()).toHaveAttribute('aria-busy', 'true');
  });

  it('saves a zip holding the daemon document and the desktop log, then says what was saved and offers Reveal', async () => {
    const exporter = fakeExport();
    await renderDiagnostics(exporter);

    await userEvent.click(exportButton());

    const saved = await screen.findByTestId('diagnostics-saved');
    expect(saved).toHaveTextContent(/Saved openfleet-diagnostics-\d{4}-\d\d-\d\d-\d{4}\.zip · \d+ (B|KB)/);
    const [bundle] = vi.mocked(exporter.saveBundle).mock.calls[0]!;
    const archiveText = new TextDecoder().decode(bundle.bytes);
    expect(bundle.fileName).toMatch(/^openfleet-diagnostics-.*\.zip$/);
    expect(archiveText).toContain('"generatedAt": "2026-10-04T10:00:00.000Z"');
    expect(archiveText).toContain('desktop log line');
    expect(screen.getByRole('button', { name: 'Reveal' })).toBeEnabled();
  });

  it('reveals the saved bundle from the Reveal button', async () => {
    const exporter = fakeExport();
    await renderDiagnostics(exporter);
    await userEvent.click(exportButton());

    await userEvent.click(await screen.findByRole('button', { name: 'Reveal' }));

    expect(exporter.revealSavedBundle).toHaveBeenCalledOnce();
  });

  it('goes back to idle, without an error, when the user dismisses the save dialog', async () => {
    const exporter = fakeExport({ saveBundle: vi.fn((): Promise<SaveBundleOutcome> => Promise.resolve({ status: 'cancelled' })) });
    await renderDiagnostics(exporter);

    await userEvent.click(exportButton());

    expect(await screen.findByRole('button', { name: 'Export…' })).toBeEnabled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByTestId('diagnostics-saved')).toBeNull();
  });

  it('says the bundle was not written and offers Try again when the file cannot be saved; Try again can succeed', async () => {
    const saveBundle = vi.fn((): Promise<SaveBundleOutcome> => Promise.resolve({ status: 'saved', path: '/x.zip' }));
    saveBundle.mockRejectedValueOnce(new Error('could not write the bundle: permission denied /Users/x'));
    await renderDiagnostics(fakeExport({ saveBundle }));

    await userEvent.click(exportButton());

    const failure = await screen.findByRole('alert');
    expect(failure).toHaveTextContent('The bundle was not written — the file could not be saved – pick another folder and try again.');
    expect(failure).not.toHaveTextContent('/Users/x');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('diagnostics-saved')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says the daemon did not answer when the document cannot be fetched, and writes nothing', async () => {
    vi.stubGlobal('fetch', daemonIsSilent());
    const exporter = fakeExport();
    await renderDiagnostics(exporter);

    await userEvent.click(exportButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('The bundle was not written — the daemon did not answer');
    expect(exporter.saveBundle).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('is unavailable outside the desktop app and says why', async () => {
    await renderDiagnostics(fakeExport({ isAvailable: false }));

    expect(exportButton()).toBeDisabled();
    expect(exportButton()).toHaveAttribute('title', 'Available in the OpenFleet desktop app');
  });
});

describe('Settings → Diagnostics → copy reference list', () => {
  beforeEach(() => vi.stubGlobal('fetch', daemonAnswers(A_DOCUMENT)));
  afterEach(() => vi.unstubAllGlobals());

  it('puts the refs on the clipboard, one per line, and confirms the count in a polite live region', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard(writeText);
    await renderDiagnostics(fakeExport());

    await userEvent.click(copyButton());

    const status = screen.getByTestId('diagnostics-copy-status');
    expect(await screen.findByText('Copied · 3 references')).toBe(status);
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(writeText).toHaveBeenCalledWith('ref aaaaaaaa\nref bbbbbbbb\nref cccccccc');
  });

  it('copies nothing and says so when the daemon has no reference yet', async () => {
    vi.stubGlobal('fetch', daemonAnswers({ ...A_DOCUMENT, log: [], health: { status: 'ok', issues: [] } }));
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard(writeText);
    await renderDiagnostics(fakeExport());

    await userEvent.click(copyButton());

    expect(await screen.findByText('No references yet · nothing was copied')).toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('reports a refused clipboard and a silent daemon as alerts', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')));
    await renderDiagnostics(fakeExport());

    await userEvent.click(copyButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('The references were not copied — the clipboard refused them');
    vi.stubGlobal('fetch', daemonIsSilent());
    await userEvent.click(copyButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('The references were not copied — the daemon did not answer');
  });
});
