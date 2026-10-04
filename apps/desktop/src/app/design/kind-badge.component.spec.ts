import { render, screen } from '@testing-library/angular/zoneless';
import { inputBinding } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { KindBadgeComponent } from './kind-badge.component';

const PERMISSION_STATE_COLOR = 'var(--state-waiting-permission)';

describe('KindBadgeComponent', () => {
  it('renders the gate kind label in upper case', async () => {
    await render(KindBadgeComponent, { bindings: [inputBinding('kind', () => 'gate')] });
    expect(screen.getByTestId('kind-badge')).toHaveTextContent('GATE');
  });

  it('renders the blocking kind as the one badge in the permission state colour', async () => {
    await render(KindBadgeComponent, { bindings: [inputBinding('kind', () => 'blocking')] });
    const badge = screen.getByTestId('kind-badge');
    const blockingColor = badge.style.getPropertyValue('--kind-color');

    expect(badge).toHaveTextContent('BLOCKING');
    expect(badge).toHaveClass('of-badge');
    expect(blockingColor).toBe(PERMISSION_STATE_COLOR);
  });

  it('is the one badge, with a state dot before the label', async () => {
    await render(KindBadgeComponent, { bindings: [inputBinding('kind', () => 'issue')] });

    const badge = screen.getByTestId('kind-badge');

    expect(badge).toHaveClass('of-badge');
    expect(badge.firstElementChild).toHaveClass('dot');
  });
});
