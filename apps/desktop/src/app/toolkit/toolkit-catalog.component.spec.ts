import { inputBinding } from '@angular/core';
import type { ToolSummary } from '@openfleet/shared';
import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ToolkitCatalogComponent } from './toolkit-catalog.component';

const TOOLS: ToolSummary[] = [
  { name: 'list_notes', domain: 'notes', category: 'read_only' },
  { name: 'delete_note', domain: 'notes', category: 'destructive' },
  { name: 'create_session', domain: 'sessions', category: 'execution_external' },
  { name: 'query_data_store', domain: 'data_stores', category: 'read_only' },
];

const renderCatalog = (tools: ToolSummary[] = TOOLS) => render(ToolkitCatalogComponent, { bindings: [inputBinding('tools', () => tools)] });

describe('ToolkitCatalogComponent', () => {
  it('groups the tools by domain, each group showing how many tools it holds', async () => {
    await renderCatalog();

    const notes = screen.getByTestId('toolkit-domain-notes');
    expect(notes).toHaveTextContent('Notes');
    expect(notes).toHaveTextContent('2');
    expect(within(notes).getByRole('button', { name: 'delete_note' })).toBeInTheDocument();
    expect(within(screen.getByTestId('toolkit-domain-data_stores')).getByRole('button', { name: 'query_data_store' })).toBeInTheDocument();
  });

  it('shows the first tool in the details until another is picked', async () => {
    await renderCatalog();

    const details = screen.getByTestId('toolkit-tool-details');
    expect(details).toHaveTextContent('query_data_store');
    expect(details).toHaveTextContent('Read only');
  });

  it('shows the domain, the category and the name Claude Code gives the tool picked', async () => {
    await renderCatalog();

    await userEvent.click(screen.getByRole('button', { name: 'create_session' }));

    const details = screen.getByTestId('toolkit-tool-details');
    expect(details).toHaveTextContent('create_session');
    expect(details).toHaveTextContent('Sessions');
    expect(details).toHaveTextContent('Runs externally');
    expect(details).toHaveTextContent('mcp__openfleet__create_session');
  });

  it('marks the tool picked as current', async () => {
    await renderCatalog();

    await userEvent.click(screen.getByRole('button', { name: 'delete_note' }));

    expect(screen.getByRole('button', { name: 'delete_note' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'list_notes' })).not.toHaveAttribute('aria-current');
  });

  it('narrows the list to the tools whose name holds the search, ignoring case', async () => {
    await renderCatalog();

    await userEvent.type(screen.getByRole('searchbox', { name: 'Search tools' }), 'NOTE');

    expect(screen.getByRole('button', { name: 'list_notes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'delete_note' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'create_session' })).toBeNull();
    expect(screen.queryByTestId('toolkit-domain-sessions')).toBeNull();
  });

  it('says no tool matches, and shows no details, when the search finds nothing', async () => {
    await renderCatalog();

    await userEvent.type(screen.getByRole('searchbox', { name: 'Search tools' }), 'zzz');

    expect(screen.getByTestId('toolkit-no-match')).toHaveTextContent('No tool matches');
    expect(screen.queryByTestId('toolkit-tool-details')).toBeNull();
  });

  it('shows the details of the first tool left when the search hides the one picked', async () => {
    await renderCatalog();
    await userEvent.click(screen.getByRole('button', { name: 'create_session' }));

    await userEvent.type(screen.getByRole('searchbox', { name: 'Search tools' }), 'note');

    expect(screen.getByTestId('toolkit-tool-details')).toHaveTextContent('delete_note');
  });
});
