import { render, screen } from '@testing-library/angular/zoneless';
import { inputBinding, signal } from '@angular/core';
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

  it('user tells the actors apart by colour: human, agent and trigger each render a different colour', async () => {
    const kind = signal<RowActorKind>('human');
    const { fixture } = await render(ActorBadgeComponent, { bindings: [inputBinding('kind', kind)] });
    const colors: string[] = [];
    for (const shownKind of ['human', 'agent', 'trigger'] as const) {
      kind.set(shownKind);
      fixture.detectChanges();
      colors.push(screen.getByTestId('actor-badge').style.color);
    }

    expect(colors.every((color) => color !== '')).toBe(true);
    expect(new Set(colors).size).toBe(3);
  });
});
