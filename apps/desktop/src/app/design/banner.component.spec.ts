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

  it('announces the error variant as an alert so screen readers interrupt for it', async () => {
    await render(BannerComponent, {
      bindings: [inputBinding('variant', () => 'error'), inputBinding('title', () => 't'), inputBinding('description', () => 'd')],
    });
    expect(screen.getByRole('alert')).toHaveTextContent('t');
  });

  it('announces the permission variant as an alert so screen readers interrupt for it', async () => {
    await render(BannerComponent, {
      bindings: [inputBinding('variant', () => 'permission'), inputBinding('title', () => 't'), inputBinding('description', () => 'd')],
    });
    expect(screen.getByRole('alert')).toHaveTextContent('t');
  });

  it('announces the reconnecting variant as a polite status update, not an interrupting alert', async () => {
    await render(BannerComponent, {
      bindings: [inputBinding('variant', () => 'reconnecting'), inputBinding('title', () => 't'), inputBinding('description', () => 'd')],
    });
    expect(screen.getByRole('status')).toHaveTextContent('t');
  });

  it('announces the done variant as a polite status update, not an interrupting alert', async () => {
    await render(BannerComponent, {
      bindings: [inputBinding('variant', () => 'done'), inputBinding('title', () => 't'), inputBinding('description', () => 'd')],
    });
    expect(screen.getByRole('status')).toHaveTextContent('t');
  });
});
