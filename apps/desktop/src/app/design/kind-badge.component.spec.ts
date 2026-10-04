import { render, screen } from '@testing-library/angular/zoneless';
import { inputBinding } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { KindBadgeComponent } from './kind-badge.component';

describe('KindBadgeComponent', () => {
  it('renders the gate kind label in upper case', async () => {
    await render(KindBadgeComponent, { bindings: [inputBinding('kind', () => 'gate')] });
    expect(screen.getByTestId('kind-badge')).toHaveTextContent('GATE');
  });

  it('is the one badge, with a state dot before the label', async () => {
    await render(KindBadgeComponent, { bindings: [inputBinding('kind', () => 'issue')] });

    const badge = screen.getByTestId('kind-badge');

    expect(badge).toHaveClass('of-badge');
    expect(badge.firstElementChild).toHaveClass('dot');
  });
});
