import type { ToolSummary } from '@openfleet/shared';
import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FleetApiService } from '../core/fleet-api.service';
import { ToolkitViewComponent } from './toolkit-view.component';

const TOOLS: ToolSummary[] = [
  { name: 'list_notes', domain: 'notes', category: 'read_only' },
  { name: 'create_session', domain: 'sessions', category: 'execution_external' },
];

async function renderToolkit(listTools: () => Promise<ToolSummary[]>) {
  const api = { listTools: vi.fn(listTools) };
  await render(ToolkitViewComponent, { providers: [{ provide: FleetApiService, useValue: api }] });
  return api;
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

  it('moves between the tabs with the arrow keys', async () => {
    await renderToolkit(() => Promise.resolve(TOOLS));
    await screen.findByRole('button', { name: 'list_notes' });
    screen.getByRole('tab', { name: 'Catalog' }).focus();

    await userEvent.keyboard('{ArrowRight}');

    expect(screen.getByRole('tab', { name: 'Harnesses' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Harnesses' })).toHaveAttribute('aria-selected', 'true');
  });

  it('offers no tab for the policy matrix or the custom tools', async () => {
    await renderToolkit(() => Promise.resolve(TOOLS));
    await screen.findByRole('button', { name: 'list_notes' });

    expect(screen.queryByRole('tab', { name: /policy|custom/i })).toBeNull();
  });
});
