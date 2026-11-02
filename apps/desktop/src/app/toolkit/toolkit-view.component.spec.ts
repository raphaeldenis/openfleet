import type { ToolSummary } from '@openfleet/shared';
import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import { ToolkitActivityClient } from '../core/toolkit-activity-client';
import { ToolkitViewComponent } from './toolkit-view.component';

const TOOLS: ToolSummary[] = [
  { name: 'list_notes', domain: 'notes', category: 'read_only' },
  { name: 'create_session', domain: 'sessions', category: 'execution_external' },
];

async function renderToolkit(listTools: () => Promise<ToolSummary[]>) {
  const api = { listTools: vi.fn(listTools) };
  const activity = { readPage: vi.fn(() => Promise.resolve({ items: [] })) };
  await render(ToolkitViewComponent, { providers: [{ provide: FleetApiService, useValue: api }, { provide: ToolkitActivityClient, useValue: activity }] });
  return Object.assign(api, { activity });
}

describe('ToolkitViewComponent', () => {
  it('shows a loading state until the daemon answers', async () => {
    await renderToolkit(() => new Promise(() => undefined));

    expect(screen.getByTestId('toolkit-loading')).toBeInTheDocument();
  });

  it('opens on the catalog of the tools the daemon lists', async () => {
    await renderToolkit(() => Promise.resolve(TOOLS));

    expect(await screen.findByRole('button', { name: 'list_notes' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Catalog' })).toHaveAttribute('aria-selected', 'true');
  });

  it('tells the user the tools are unavailable and reads again on Retry', async () => {
    let attempts = 0;
    const api = await renderToolkit(() => (++attempts === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(TOOLS)));
    expect(await screen.findByTestId('toolkit-error')).toHaveTextContent('Tools unavailable');

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('button', { name: 'list_notes' })).toBeInTheDocument();
    expect(api.listTools).toHaveBeenCalledTimes(2);
  });

  it('says there is no tool when the daemon lists none', async () => {
    await renderToolkit(() => Promise.resolve([]));

    expect(await screen.findByTestId('toolkit-empty')).toHaveTextContent('No tools');
  });

  it('switches to the harnesses when the user picks that tab', async () => {
    await renderToolkit(() => Promise.resolve(TOOLS));
    await screen.findByRole('button', { name: 'list_notes' });

    await userEvent.click(screen.getByRole('tab', { name: 'Harnesses' }));

    expect(screen.getByRole('tab', { name: 'Harnesses' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('toolkit-harness-claude-code')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'list_notes' })).toBeNull();
  });

  it('opens the activity of a tool from its details in the catalog', async () => {
    const api = await renderToolkit(() => Promise.resolve(TOOLS));
    await userEvent.click(await screen.findByRole('button', { name: 'create_session' }));

    await userEvent.click(screen.getByRole('button', { name: 'View calls →' }));

    expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
    expect(api.activity.readPage).toHaveBeenCalledWith({ tool: 'create_session' });
  });

  it('shows all the calls again once the tool filter is cleared', async () => {
    const api = await renderToolkit(() => Promise.resolve(TOOLS));
    await userEvent.click(await screen.findByRole('button', { name: 'create_session' }));
    await userEvent.click(screen.getByRole('button', { name: 'View calls →' }));

    await userEvent.click(await screen.findByRole('button', { name: 'Clear tool filter create_session' }));

    expect(api.activity.readPage).toHaveBeenLastCalledWith({});
  });

  it('reads the activity even when the tool list fails, since the log does not depend on it', async () => {
    const api = await renderToolkit(() => Promise.reject(new Error('boom')));
    await screen.findByTestId('toolkit-error');

    await userEvent.click(screen.getByRole('tab', { name: 'Activity' }));

    expect(api.activity.readPage).toHaveBeenCalled();
    expect(screen.queryByTestId('toolkit-error')).toBeNull();
  });

  it('moves between the tabs with the arrow keys', async () => {
    await renderToolkit(() => Promise.resolve(TOOLS));
    await screen.findByRole('button', { name: 'list_notes' });
    screen.getByRole('tab', { name: 'Catalog' }).focus();

    await userEvent.keyboard('{ArrowRight}');

    expect(screen.getByRole('tab', { name: 'Activity' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
  });

  it('offers no tab for the policy matrix or the custom tools', async () => {
    await renderToolkit(() => Promise.resolve(TOOLS));
    await screen.findByRole('button', { name: 'list_notes' });

    expect(screen.queryByRole('tab', { name: /policy|custom/i })).toBeNull();
  });
});
