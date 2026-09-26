import { render, screen } from '@testing-library/angular/zoneless';
import { inputBinding } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { KindBadgeComponent } from './kind-badge.component';

describe('KindBadgeComponent', () => {
  it('renders the gate kind label in upper case', async () => {
    await render(KindBadgeComponent, { bindings: [inputBinding('kind', () => 'gate')] });
    expect(screen.getByTestId('kind-badge')).toHaveTextContent('GATE');
  });
});
