import { render, screen } from '@testing-library/angular/zoneless';
import { inputBinding } from '@angular/core';
import type { RowActorKind } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { ActorBadgeComponent } from './actor-badge.component';


describe('ActorBadgeComponent', () => {
  it.each<[RowActorKind, string]>([
    ['human', 'HUMAN'],
    ['agent', 'AGENT'],
    ['trigger', 'TRIGGER'],
  ])('shows who made the change: a %s actor reads %s', async (kind, label) => {
    await render(ActorBadgeComponent, { bindings: [inputBinding('kind', () => kind)] });

    expect(screen.getByTestId('actor-badge')).toHaveTextContent(label);
  });

  it('writes the label in the foreground colour and carries the actor colour on a dot', async () => {
    await render(ActorBadgeComponent, { bindings: [inputBinding('kind', () => 'agent')] });

    const badge = screen.getByTestId('actor-badge');

    expect(getComputedStyle(badge).color).toBe('var(--fg)');
    expect(badge.style.getPropertyValue('--actor-color')).toBe('var(--state-generating)');
    expect(badge.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
});
