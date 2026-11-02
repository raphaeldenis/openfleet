import { inputBinding, outputBinding } from '@angular/core';
import type { ActivityPage, ActivityRow } from '@openfleet/shared';
import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FleetApiService, type ActivityQueryParams } from '../core/fleet-api.service';
import { ToolkitActivityComponent } from './toolkit-activity.component';

const row = (overrides: Partial<ActivityRow> = {}): ActivityRow => ({
  id: 1,
  at: '2026-11-02T10:00:00.000Z',
  actorKind: 'agent',
  actorLabel: 'Gimli',
  source: 'mcp',
  action: 'create_note',
  outcome: 'ok',
  durationMs: 12,
  argsExcerpt: '{"title":"[text len=9]","[key len=6]":"[secret]"}',
  resultExcerpt: '[result len=40]',
  ...overrides,
});

async function renderActivity(listActivity: (query: ActivityQueryParams) => Promise<ActivityPage>, options: { tool?: string; onToolCleared?: () => void } = {}) {
  const client = { listActivity: vi.fn(listActivity) };
  await render(ToolkitActivityComponent, {
    providers: [{ provide: FleetApiService, useValue: client }],
    bindings: [inputBinding('tool', () => options.tool), outputBinding('toolCleared', () => options.onToolCleared?.())],
  });
  return client;
}

describe('ToolkitActivityComponent', () => {
  it('shows a loading state until the daemon answers', async () => {
    await renderActivity(() => new Promise(() => undefined));

    expect(screen.getByTestId('toolkit-activity-loading')).toBeInTheDocument();
  });

  it('lists each call with its caller, tool, status and duration', async () => {
    await renderActivity(() => Promise.resolve({ items: [row(), row({ id: 2, action: 'delete_note', outcome: 'denied', durationMs: undefined, actorLabel: 'Nori' })] }));

    const first = await screen.findByTestId('toolkit-activity-row-1');
    expect(first).toHaveTextContent('Gimli');
    expect(first).toHaveTextContent('create_note');
    expect(first).toHaveTextContent('ok');
    expect(first).toHaveTextContent('12 ms');
    const second = screen.getByTestId('toolkit-activity-row-2');
    expect(second).toHaveTextContent('denied');
    expect(second).toHaveTextContent('—');
  });

  it('shows the marks of the log as they are, with no text of the call', async () => {
    await renderActivity(() => Promise.resolve({ items: [row()] }));

    const cell = within(await screen.findByTestId('toolkit-activity-row-1'));

    expect(cell.getByText('{"title":"[text len=9]","[key len=6]":"[secret]"}')).toBeInTheDocument();
    expect(cell.getByText(/→ \[result len=40\]/)).toBeInTheDocument();
  });

  it('shows a control character of a label as an escape, never as a reordering of the text', async () => {
    await renderActivity(() => Promise.resolve({ items: [row({ actorLabel: 'ab‮cd' })] }));

    expect(await screen.findByTestId('toolkit-activity-row-1')).toHaveTextContent('ab<U+202E>cd');
  });

  it('explains that nothing was recorded when the log holds no call', async () => {
    await renderActivity(() => Promise.resolve({ items: [] }));

    expect(await screen.findByTestId('toolkit-activity-empty')).toHaveTextContent('No calls recorded');
  });

  it('tells the user the activity is unavailable and reads again on Retry', async () => {
    let attempts = 0;
    const client = await renderActivity(() => (++attempts === 1 ? Promise.reject(new Error('boom')) : Promise.resolve({ items: [row()] })));
    expect(await screen.findByTestId('toolkit-activity-error')).toHaveTextContent('Activity unavailable');

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByTestId('toolkit-activity-row-1')).toBeInTheDocument();
    expect(client.listActivity).toHaveBeenCalledTimes(2);
  });

  it('reads only the errors when the user picks Errors only', async () => {
    const client = await renderActivity(() => Promise.resolve({ items: [row()] }));
    await screen.findByTestId('toolkit-activity-row-1');

    await userEvent.click(screen.getByRole('button', { name: 'Errors only' }));

    expect(client.listActivity).toHaveBeenLastCalledWith({ actor: 'agent', outcome: 'error' });
    expect(screen.getByRole('button', { name: 'Errors only' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reads only the refused calls when the user picks Denied', async () => {
    const client = await renderActivity(() => Promise.resolve({ items: [] }));
    await screen.findByTestId('toolkit-activity-empty');

    await userEvent.click(screen.getByRole('button', { name: 'Denied' }));

    expect(client.listActivity).toHaveBeenLastCalledWith({ actor: 'agent', outcome: 'denied' });
  });

  it('reads the calls of the tool it is given and lets the user drop that filter', async () => {
    const onToolCleared = vi.fn();
    const client = await renderActivity(() => Promise.resolve({ items: [row()] }), { tool: 'create_note', onToolCleared });
    await screen.findByTestId('toolkit-activity-row-1');
    expect(client.listActivity).toHaveBeenCalledWith({ actor: 'agent', action: 'create_note' });

    await userEvent.click(screen.getByRole('button', { name: 'Clear tool filter create_note' }));

    expect(onToolCleared).toHaveBeenCalledOnce();
  });

  it('appends the next page with the cursor when the user loads more, and hides the button on the last page', async () => {
    const pages: Record<string, ActivityPage> = {
      first: { items: [row({ id: 2 })], nextCursor: '2' },
      '2': { items: [row({ id: 1 })] },
    };
    const client = await renderActivity((request) => Promise.resolve(pages[request.cursor ?? 'first']!));
    await screen.findByTestId('toolkit-activity-row-2');

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByTestId('toolkit-activity-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('toolkit-activity-row-2')).toBeInTheDocument();
    expect(client.listActivity).toHaveBeenLastCalledWith({ actor: 'agent', cursor: '2' });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('keeps the rows already shown and says so when loading more fails', async () => {
    let calls = 0;
    await renderActivity(() => (++calls === 1 ? Promise.resolve({ items: [row()], nextCursor: '1' }) : Promise.reject(new Error('boom'))));
    await screen.findByTestId('toolkit-activity-row-1');

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByTestId('toolkit-activity-more-error')).toHaveTextContent('Could not load more');
    expect(screen.getByTestId('toolkit-activity-row-1')).toBeInTheDocument();
  });

  it('keeps the table in a scrollable region a keyboard user can reach', async () => {
    await renderActivity(() => Promise.resolve({ items: [row()] }));

    expect(await screen.findByRole('region', { name: 'MCP tool calls' })).toHaveAttribute('tabindex', '0');
  });
});
