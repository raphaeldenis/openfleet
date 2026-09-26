import { render, screen } from '@testing-library/angular/zoneless';
import { inputBinding } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { BannerComponent } from './banner.component';

describe('BannerComponent', () => {
  it('renders the title and description for the permission variant', async () => {
    await render(BannerComponent, {
      bindings: [
        inputBinding('variant', () => 'permission'),
        inputBinding('title', () => '! Permission needed'),
        inputBinding('description', () => 'Approve or deny in the terminal.'),
      ],
    });
    expect(screen.getByTestId('banner')).toHaveTextContent('! Permission needed');
    expect(screen.getByTestId('banner')).toHaveTextContent('Approve or deny in the terminal.');
  });

  it('accepts the error variant without throwing', async () => {
    await render(BannerComponent, {
      bindings: [inputBinding('variant', () => 'error'), inputBinding('title', () => 't'), inputBinding('description', () => 'd')],
    });
    expect(screen.getByTestId('banner')).toHaveAttribute('data-variant', 'error');
  });
});
