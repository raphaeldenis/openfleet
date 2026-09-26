import { render, screen } from '@testing-library/angular/zoneless';
import { inputBinding } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { KindBadgeComponent } from './kind-badge.component';

describe('KindBadgeComponent', () => {
  it.each(['gate', 'question', 'law', 'permission', 'resource'] as const)(
    'renders the %s kind label in upper case',
    async (kind) => {
      await render(KindBadgeComponent, { bindings: [inputBinding('kind', () => kind)] });
      expect(screen.getByTestId('kind-badge')).toHaveTextContent(kind.toUpperCase());
    },
  );
});
