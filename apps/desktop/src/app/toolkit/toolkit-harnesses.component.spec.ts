import { inputBinding } from '@angular/core';
import type { ToolSummary } from '@openfleet/shared';
import { render, screen, within } from '@testing-library/angular/zoneless';
import { describe, expect, it } from 'vitest';
import { ToolkitHarnessesComponent } from './toolkit-harnesses.component';

const TOOLS: ToolSummary[] = [
  { name: 'list_notes', domain: 'notes', category: 'read_only' },
  { name: 'create_session', domain: 'sessions', category: 'execution_external' },
];

const renderHarnesses = () => render(ToolkitHarnessesComponent, { bindings: [inputBinding('tools', () => TOOLS)] });

describe('ToolkitHarnessesComponent', () => {
  it('shows a card for each known harness', async () => {
    await renderHarnesses();

    const cards = screen.getAllByTestId(/^toolkit-harness-/);

    expect(cards).toHaveLength(8);
    expect(cards[0]).toHaveTextContent('Claude Code');
  });

  it('says Claude Code is supported and the others are unknown, without inventing a state', async () => {
    await renderHarnesses();

    expect(screen.getByTestId('toolkit-harness-claude-code')).toHaveTextContent('Supported');
    expect(screen.getByTestId('toolkit-harness-codex')).toHaveTextContent('Unknown');
    expect(screen.getByTestId('toolkit-harness-kimi')).toHaveTextContent('Unknown');
  });

  it('lists each tool with the name Claude Code sees', async () => {
    await renderHarnesses();

    const row = screen.getByTestId('toolkit-claude-code-name-create_session');

    expect(within(row).getByText('create_session')).toBeInTheDocument();
    expect(within(row).getByText('mcp__openfleet__create_session')).toBeInTheDocument();
  });

  it('keeps the table in a scrollable region a keyboard user can reach', async () => {
    await renderHarnesses();

    expect(screen.getByRole('region', { name: 'Tool names per harness' })).toHaveAttribute('tabindex', '0');
  });
});
