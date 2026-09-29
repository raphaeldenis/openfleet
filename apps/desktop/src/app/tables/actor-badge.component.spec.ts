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

  it.each<[RowActorKind, string]>([
    ['human', 'var(--state-idle)'],
    ['agent', 'var(--state-generating)'],
    ['trigger', 'var(--state-thinking)'],
  ])('user tells the actors apart by colour: a %s actor is %s', async (kind, expectedColor) => {
    await render(ActorBadgeComponent, { bindings: [inputBinding('kind', () => kind)] });

    expect(screen.getByTestId('actor-badge').style.color).toBe(expectedColor);
  });
});
