import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import type { ActivityPage, ActivityRow } from '@openfleet/shared';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILE_DOWNLOAD, type TextFile } from '../core/file-download';
import type { ActivityQueryParams } from '../core/fleet-api.service';
import { FleetApiService } from '../core/fleet-api.service';
import { AuditViewComponent } from './audit-view.component';

const NOW = new Date('2026-11-01T15:00:00.000Z');

const row = (overrides: Partial<ActivityRow> = {}): ActivityRow => ({
  id: 7,
  at: '2026-11-01T14:10:03.250Z',
  actorKind: 'agent',
  actorLabel: 'gimli',
  source: 'mcp',
  action: 'create_note',
  outcome: 'ok',
  ...overrides,
});

type ListActivity = (query: ActivityQueryParams) => Promise<ActivityPage>;

const downloads: TextFile[] = [];

async function renderAudit(listActivity: ListActivity) {
  downloads.length = 0;
  const api = { listActivity: vi.fn(listActivity) };
  await render(AuditViewComponent, {
    providers: [
      provideRouter([]),
      { provide: FleetApiService, useValue: api },
      { provide: FILE_DOWNLOAD, useValue: (file: TextFile) => downloads.push(file) },
    ],
  });
  return api;
}

const lastQuery = (api: { listActivity: { mock: { calls: ActivityQueryParams[][] } } }): ActivityQueryParams => api.listActivity.mock.calls.at(-1)![0];

describe('AuditViewComponent', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  });

  afterEach(() => vi.useRealTimers());

  it('shows a loading state until the daemon answers', async () => {
    await renderAudit(() => new Promise(() => undefined));

    expect(screen.getByTestId('audit-loading')).toBeInTheDocument();
  });

  it('asks for the last 24 hours, one page of 50, when it opens', async () => {
    const api = await renderAudit(() => Promise.resolve({ items: [] }));
    await screen.findByTestId('audit-empty');

    expect(lastQuery(api)).toEqual({ since: '2026-10-31T15:00:00.000Z', limit: 50 });
  });

  describe('rows', () => {
    it('lists the time, actor, action, entity and outcome of each action', async () => {
      await renderAudit(() => Promise.resolve({ items: [row({ entityKind: 'note', entityLabel: 'house-rules', outcome: 'denied' })] }));

      const line = await screen.findByTestId('audit-row-7');
      expect(line).toHaveTextContent('2026-11-01 14:10:03');
      expect(line).toHaveTextContent('agent');
      expect(line).toHaveTextContent('gimli');
      expect(line).toHaveTextContent('create_note');
      expect(line).toHaveTextContent('note');
      expect(line).toHaveTextContent('house-rules');
      expect(line).toHaveTextContent('denied');
    });

    it('falls back on the entity id when the entity has no label', async () => {
      await renderAudit(() => Promise.resolve({ items: [row({ entityKind: 'session', entityId: '3f2a9c1e-0000-4000-8000-000000000001' })] }));

      expect(await screen.findByTestId('audit-row-7')).toHaveTextContent('3f2a9c1e-0000-4000-8000-000000000001');
    });

    it('shows the redaction marks exactly as the daemon wrote them', async () => {
      await renderAudit(() => Promise.resolve({ items: [row({ entityLabel: '[text len=12]', actorLabel: '[key len=4]' })] }));

      const line = await screen.findByTestId('audit-row-7');
      expect(line).toHaveTextContent('[text len=12]');
      expect(line).toHaveTextContent('[key len=4]');
    });

    it('renders hostile text as inert text, bidi controls spelled out', async () => {
      await renderAudit(() => Promise.resolve({ items: [row({ actorLabel: '<img src=x onerror=alert(1)>', entityLabel: 'a‮b' })] }));

      const line = await screen.findByTestId('audit-row-7');
      expect(line).toHaveTextContent('<img src=x onerror=alert(1)>');
      expect(line.querySelector('img')).toBeNull();
      expect(line).toHaveTextContent('a<U+202E>b');
    });
  });

  describe('filters', () => {
    it.each([
      ['Actor', 'human', { actor: 'human' }],
      ['Outcome', 'denied', { outcome: 'denied' }],
    ])('narrows the log by %s', async (label, choice, expected) => {
      const api = await renderAudit(() => Promise.resolve({ items: [] }));
      await screen.findByTestId('audit-empty');

      await userEvent.selectOptions(screen.getByRole('combobox', { name: label }), choice);

      expect(lastQuery(api)).toMatchObject(expected);
    });

    it('narrows the log by action once the user commits the text', async () => {
      const api = await renderAudit(() => Promise.resolve({ items: [] }));
      await screen.findByTestId('audit-empty');

      await userEvent.type(screen.getByRole('textbox', { name: 'Action' }), ' gate.approve {Enter}');

      expect(lastQuery(api)).toMatchObject({ action: 'gate.approve' });
    });

    it('widens the period to all time by sending no lower bound', async () => {
      const api = await renderAudit(() => Promise.resolve({ items: [] }));
      await screen.findByTestId('audit-empty');

      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Period' }), 'allTime');

      expect(lastQuery(api).since).toBeUndefined();
    });

    it('moves the lower bound back to seven days', async () => {
      const api = await renderAudit(() => Promise.resolve({ items: [] }));
      await screen.findByTestId('audit-empty');

      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Period' }), 'last7Days');

      expect(lastQuery(api).since).toBe('2026-10-25T15:00:00.000Z');
    });

    it('starts again from the newest rows when a filter changes', async () => {
      const api = await renderAudit((query) => Promise.resolve(query.cursor ? { items: [row({ id: 3 })] } : { items: [row({ id: 5 })], nextCursor: '5' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
      expect(await screen.findByTestId('audit-row-3')).toBeInTheDocument();

      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Actor' }), 'system');

      expect(lastQuery(api).cursor).toBeUndefined();
      expect(await screen.findByTestId('audit-row-5')).toBeInTheDocument();
      expect(screen.queryByTestId('audit-row-3')).toBeNull();
    });

    it('ignores the answer of a request that a newer filter replaced', async () => {
      const answers: Array<(page: ActivityPage) => void> = [];
      await renderAudit(() => new Promise((resolve) => answers.push(resolve)));

      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Actor' }), 'human');
      answers[1]!({ items: [row({ id: 2 })] });
      answers[0]!({ items: [row({ id: 1 })] });

      expect(await screen.findByTestId('audit-row-2')).toBeInTheDocument();
      expect(screen.queryByTestId('audit-row-1')).toBeNull();
    });
  });

  describe('pagination', () => {
    it('appends the next page, read with the cursor of the first', async () => {
      const api = await renderAudit((query) => Promise.resolve(query.cursor ? { items: [row({ id: 3 })] } : { items: [row({ id: 5 })], nextCursor: '5' }));

      await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));

      expect(await screen.findByTestId('audit-row-3')).toBeInTheDocument();
      expect(screen.getByTestId('audit-row-5')).toBeInTheDocument();
      expect(lastQuery(api).cursor).toBe('5');
    });

    it('offers no Load more on the last page', async () => {
      await renderAudit(() => Promise.resolve({ items: [row()] }));
      await screen.findByTestId('audit-row-7');

      expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    });

    it('keeps the rows shown and offers a retry when the next page fails', async () => {
      let attempts = 0;
      await renderAudit((query) => {
        if (!query.cursor) return Promise.resolve({ items: [row({ id: 5 })], nextCursor: '5' });
        return ++attempts === 1 ? Promise.reject(new Error('boom')) : Promise.resolve({ items: [row({ id: 3 })] });
      });
      await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));

      expect(await screen.findByTestId('audit-more-error')).toBeInTheDocument();
      expect(screen.getByTestId('audit-row-5')).toBeInTheDocument();

      await userEvent.click(within(screen.getByTestId('audit-more-error')).getByRole('button', { name: 'Retry' }));

      expect(await screen.findByTestId('audit-row-3')).toBeInTheDocument();
    });
  });

  describe('states', () => {
    it('tells the user nothing matches and offers to reset the filters once one is set', async () => {
      const api = await renderAudit(() => Promise.resolve({ items: [] }));
      await screen.findByTestId('audit-empty');
      expect(screen.queryByRole('button', { name: 'Reset filters' })).toBeNull();

      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Actor' }), 'human');
      await userEvent.click(await screen.findByRole('button', { name: 'Reset filters' }));

      expect(lastQuery(api)).toEqual({ since: '2026-10-31T15:00:00.000Z', limit: 50 });
      expect(screen.getByTestId('audit-empty')).toHaveTextContent('No actions match');
    });

    it('tells the user the log is unavailable and reads again on Retry', async () => {
      let attempts = 0;
      const api = await renderAudit(() => (++attempts === 1 ? Promise.reject(new Error('boom')) : Promise.resolve({ items: [row()] })));
      expect(await screen.findByTestId('audit-error')).toHaveTextContent('Audit log unavailable');

      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

      expect(await screen.findByTestId('audit-row-7')).toBeInTheDocument();
      expect(api.listActivity).toHaveBeenCalledTimes(2);
    });
  });

  describe('session link', () => {
    it('links a row to the session that acted when the row carries its id', async () => {
      await renderAudit(() => Promise.resolve({ items: [row({ sessionId: '3f2a9c1e-0000-4000-8000-000000000001' })] }));

      const link = await screen.findByRole('link', { name: 'Open session of create_note' });

      expect(link).toHaveAttribute('href', '/session/3f2a9c1e-0000-4000-8000-000000000001');
    });

    it('offers no link on a row without a session', async () => {
      await renderAudit(() => Promise.resolve({ items: [row()] }));
      await screen.findByTestId('audit-row-7');

      expect(screen.queryByRole('link')).toBeNull();
    });

    it('does not turn a redaction mark into a link', async () => {
      await renderAudit(() => Promise.resolve({ items: [row({ sessionId: '[text len=12]' })] }));
      await screen.findByTestId('audit-row-7');

      expect(screen.queryByRole('link')).toBeNull();
    });
  });

  describe('export', () => {
    const twoPages: ListActivity = (query) => Promise.resolve(query.cursor ? { items: [row({ id: 3 })] } : { items: [row({ id: 5 })], nextCursor: '5' });

    it('saves every page of the current filter as a JSON file', async () => {
      const api = await renderAudit(twoPages);
      await screen.findByTestId('audit-row-5');
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Actor' }), 'human');
      await screen.findByTestId('audit-row-5');

      await userEvent.click(screen.getByRole('button', { name: 'Export JSON' }));

      await vi.waitFor(() => expect(downloads).toHaveLength(1));
      expect(downloads[0]!.filename).toBe('openfleet-audit-2026-11-01.json');
      expect(downloads[0]!.mimeType).toBe('application/json');
      expect(JSON.parse(downloads[0]!.content).map((exported: ActivityRow) => exported.id)).toEqual([5, 3]);
      const exportQueries = api.listActivity.mock.calls.slice(-2).map(([query]) => query);
      expect(exportQueries.map((query) => query.actor)).toEqual(['human', 'human']);
      expect(exportQueries[1]!.cursor).toBe('5');
    });

    it('saves the current filter as a CSV file', async () => {
      await renderAudit(twoPages);
      await screen.findByTestId('audit-row-5');

      await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

      await vi.waitFor(() => expect(downloads).toHaveLength(1));
      expect(downloads[0]!.filename).toBe('openfleet-audit-2026-11-01.csv');
      expect(downloads[0]!.mimeType).toBe('text/csv');
      expect(downloads[0]!.content.split('\r\n')).toHaveLength(3);
    });

    it('saves nothing and says so when a page cannot be read', async () => {
      let isExporting = false;
      await renderAudit((query) => (isExporting && query.cursor ? Promise.reject(new Error('boom')) : twoPages(query)));
      await screen.findByTestId('audit-row-5');
      isExporting = true;

      await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

      expect(await screen.findByTestId('audit-export-error')).toHaveTextContent('Export failed');
      expect(downloads).toHaveLength(0);
    });

    it('offers no export while there is nothing to export', async () => {
      await renderAudit(() => Promise.resolve({ items: [] }));
      await screen.findByTestId('audit-empty');

      expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Export JSON' })).toBeNull();
    });
  });

  describe('detail', () => {
    const detailed = row({
      sessionId: '3f2a9c1e-0000-4000-8000-000000000001',
      managerId: '9b1d4e2f-0000-4000-8000-000000000002',
      entityKind: 'note',
      entityId: 'n-12',
      durationMs: 42,
      detail: 'ValidationError',
      argsExcerpt: 'title=[text len=9] pinned=true',
      resultExcerpt: '[result len=31]',
    });

    it('opens the full record of a row on demand and closes it again', async () => {
      await renderAudit(() => Promise.resolve({ items: [detailed] }));
      const toggle = await screen.findByRole('button', { name: 'Details of create_note' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByTestId('audit-detail-7')).toBeNull();

      await userEvent.click(toggle);

      const detail = screen.getByTestId('audit-detail-7');
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      for (const shown of ['3f2a9c1e-0000-4000-8000-000000000001', '9b1d4e2f-0000-4000-8000-000000000002', 'n-12', 'mcp', '42 ms', 'ValidationError', 'title=[text len=9] pinned=true', '[result len=31]']) {
        expect(detail).toHaveTextContent(shown);
      }

      await userEvent.click(toggle);

      expect(screen.queryByTestId('audit-detail-7')).toBeNull();
    });

    it('leaves out the fields a row does not carry', async () => {
      await renderAudit(() => Promise.resolve({ items: [row()] }));

      await userEvent.click(await screen.findByRole('button', { name: 'Details of create_note' }));

      const detail = screen.getByTestId('audit-detail-7');
      expect(detail).not.toHaveTextContent('Duration');
      expect(detail).not.toHaveTextContent('Arguments');
    });
  });
});
