import { inputBinding, signal, twoWayBinding } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular/zoneless';
import { describe, expect, it } from 'vitest';
import { ChoiceCardsComponent, type ChoiceCard } from './choice-cards.component';

const CARDS: ChoiceCard[] = [
  { value: 'available', label: 'Available' },
  { value: 'unavailable', label: 'Unavailable', isAvailable: false, unavailableReason: 'not installed' },
];

async function renderCards(initialValue: string) {
  const chosenValue = signal(initialValue);
  await render(ChoiceCardsComponent, {
    bindings: [inputBinding('label', () => 'Harness'), inputBinding('cards', () => CARDS), twoWayBinding('value', chosenValue)],
  });
  return { chosenValue };
}

describe('ChoiceCardsComponent', () => {
  it('keeps the value when the change event of an unavailable card fires', async () => {
    const { chosenValue } = await renderCards('available');

    fireEvent.change(screen.getByRole('radio', { name: 'Unavailable' }));

    expect(chosenValue()).toBe('available');
  });

  it('sets the value when the change event of an available card fires', async () => {
    const { chosenValue } = await renderCards('unavailable');

    fireEvent.change(screen.getByRole('radio', { name: 'Available' }));

    expect(chosenValue()).toBe('available');
  });
});
