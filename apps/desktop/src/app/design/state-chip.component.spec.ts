import { render, screen } from '@testing-library/angular/zoneless';
import { inputBinding } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { StateChipComponent, type ChipState } from './state-chip.component';

describe('StateChipComponent', () => {
  it.each([
    ['starting', '◌', 'starting'],
    ['generating', '▶', 'generating'],
    ['waiting_permission', '!', 'waiting permission'],
    ['waiting_input', '?', 'waiting input'],
    ['idle', '○', 'idle'],
    ['closed', '■', 'closed'],
  ] as const)('renders %s as icon %s with label "%s"', async (state, icon, label) => {
    await render(StateChipComponent, { bindings: [inputBinding('state', () => state)] });
    expect(screen.getByTestId('state-chip')).toHaveTextContent(`${icon}${label}`);
  });

  it('renders a distinct chip for "thinking", a state SESSION_STATES does not have yet', async () => {
    await render(StateChipComponent, { bindings: [inputBinding('state', () => 'thinking')] });
    expect(screen.getByTestId('state-chip')).toHaveTextContent('◐thinking');
    expect(screen.getByTestId('state-chip')).toHaveAttribute('data-live', '1');
  });

  it('renders a distinct, blinking chip for "error", a state SESSION_STATES does not have yet', async () => {
    await render(StateChipComponent, { bindings: [inputBinding('state', () => 'error')] });
    expect(screen.getByTestId('state-chip')).toHaveTextContent('✕error');
    expect(screen.getByTestId('state-chip')).toHaveAttribute('data-errblink', '1');
  });

  it('marks generating and thinking as live (pulsing)', async () => {
    await render(StateChipComponent, { bindings: [inputBinding('state', () => 'generating')] });
    expect(screen.getByTestId('state-chip')).toHaveAttribute('data-live', '1');
  });

  it('does not mark idle as live or blinking', async () => {
    await render(StateChipComponent, { bindings: [inputBinding('state', () => 'idle')] });
    expect(screen.getByTestId('state-chip')).not.toHaveAttribute('data-live');
    expect(screen.getByTestId('state-chip')).not.toHaveAttribute('data-errblink');
  });

  it('applies a dashed, 70%-opacity "stale" look when stale is true', async () => {
    await render(StateChipComponent, {
      bindings: [inputBinding('state', () => 'idle'), inputBinding('stale', () => true)],
    });
    expect(screen.getByTestId('state-chip')).toHaveAttribute('data-stale', '1');
  });

  it('does not throw for a state string outside the known ChipState union (a future backend state the frontend has not learned yet)', async () => {
    const unknownFutureState = 'reviewing' as unknown as ChipState;
    await render(StateChipComponent, { bindings: [inputBinding('state', () => unknownFutureState)] });
    expect(screen.getByTestId('state-chip')).toBeInTheDocument();
  });

  it('renders the idle label in the foreground token, not the state color, so it stays readable on the tinted chip background', async () => {
    await render(StateChipComponent, { bindings: [inputBinding('state', () => 'idle')] });
    expect(screen.getByTestId('state-chip-label')).toHaveStyle({ color: 'var(--fg)' });
  });
});
