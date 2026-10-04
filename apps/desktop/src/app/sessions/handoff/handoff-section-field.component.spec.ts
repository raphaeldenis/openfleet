import { inputBinding, outputBinding } from '@angular/core';
import { render, screen } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HandoffSectionFieldComponent } from './handoff-section-field.component';

describe('HandoffSectionFieldComponent', () => {
  it('labels the textarea with the section label', async () => {
    await render(HandoffSectionFieldComponent, {
      bindings: [inputBinding('label', () => 'Decisions'), inputBinding('value', () => '')],
    });

    expect(screen.getByRole('textbox', { name: 'Decisions' })).toBeInTheDocument();
  });

  it('shows the value', async () => {
    await render(HandoffSectionFieldComponent, {
      bindings: [inputBinding('label', () => 'Goal'), inputBinding('value', () => 'Ship it')],
    });

    expect(screen.getByRole('textbox', { name: 'Goal' })).toHaveValue('Ship it');
  });

  it('emits the new text when the user types', async () => {
    const valueChange = vi.fn();
    await render(HandoffSectionFieldComponent, {
      bindings: [inputBinding('label', () => 'Goal'), inputBinding('value', () => ''), outputBinding('valueChange', valueChange)],
    });

    await userEvent.type(screen.getByRole('textbox', { name: 'Goal' }), 'ab');

    expect(valueChange).toHaveBeenLastCalledWith('ab');
  });

  it('limits the text to 20000 characters', async () => {
    await render(HandoffSectionFieldComponent, {
      bindings: [inputBinding('label', () => 'Goal'), inputBinding('value', () => '')],
    });

    expect(screen.getByRole('textbox', { name: 'Goal' })).toHaveAttribute('maxlength', '20000');
  });

  it('cannot be edited when disabled', async () => {
    await render(HandoffSectionFieldComponent, {
      bindings: [inputBinding('label', () => 'Goal'), inputBinding('value', () => 'x'), inputBinding('disabled', () => true)],
    });

    expect(screen.getByRole('textbox', { name: 'Goal' })).toBeDisabled();
  });

  it.each([
    ['working_state', 'from the state panel'],
    ['git', 'from git'],
    ['session', 'from the session'],
    ['manager', 'from the mission'],
    ['none', 'write it here'],
  ] as const)('describes a %s source in words, not colour', async (source, caption) => {
    await render(HandoffSectionFieldComponent, {
      bindings: [inputBinding('label', () => 'Goal'), inputBinding('value', () => ''), inputBinding('source', () => source)],
    });

    expect(screen.getByRole('textbox', { name: 'Goal' })).toHaveAccessibleDescription(caption);
  });

  it('shows no caption when the source is unknown', async () => {
    await render(HandoffSectionFieldComponent, {
      bindings: [inputBinding('label', () => 'Goal'), inputBinding('value', () => '')],
    });

    expect(screen.getByRole('textbox', { name: 'Goal' })).not.toHaveAccessibleDescription();
  });
});
