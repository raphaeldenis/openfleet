import { render, screen } from '@testing-library/angular/zoneless';
import { inputBinding } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { PulseRingComponent } from './pulse-ring.component';

describe('PulseRingComponent', () => {
  it('draws an empty ring when the pulse just fired', async () => {
    await render(PulseRingComponent, { bindings: [inputBinding('fractionElapsed', () => 0)] });
    const circle = screen.getByTestId('pulse-ring-progress');
    expect(circle.getAttribute('stroke-dasharray')).toMatch(/^0[ ,]/);
  });

  it('draws a full ring right before the pulse is due', async () => {
    await render(PulseRingComponent, { bindings: [inputBinding('fractionElapsed', () => 1)] });
    const circle = screen.getByTestId('pulse-ring-progress');
    const [drawn, total] = circle.getAttribute('stroke-dasharray')!.split(/[ ,]/).map(Number);
    expect(drawn).toBeCloseTo(total, 1);
  });

  it('draws a half-filled ring at the midpoint between pulses', async () => {
    await render(PulseRingComponent, { bindings: [inputBinding('fractionElapsed', () => 0.5)] });
    const circle = screen.getByTestId('pulse-ring-progress');
    const [drawn, total] = circle.getAttribute('stroke-dasharray')!.split(/[ ,]/).map(Number);
    expect(drawn).toBeCloseTo(total / 2, 0);
  });

  it('exposes an accessible progressbar with the elapsed fraction as a 0-100 value', async () => {
    await render(PulseRingComponent, { bindings: [inputBinding('fractionElapsed', () => 0.5)] });
    const progressbar = screen.getByRole('progressbar', { name: 'Next pulse' });
    expect(progressbar).toHaveAttribute('aria-valuemin', '0');
    expect(progressbar).toHaveAttribute('aria-valuemax', '100');
    expect(progressbar).toHaveAttribute('aria-valuenow', '50');
  });

  it('accepts a custom accessible label', async () => {
    await render(PulseRingComponent, {
      bindings: [inputBinding('fractionElapsed', () => 0), inputBinding('label', () => 'Time to next check-in')],
    });
    expect(screen.getByRole('progressbar', { name: 'Time to next check-in' })).toBeInTheDocument();
  });

  it('clamps a fraction below 0 to an empty ring', async () => {
    await render(PulseRingComponent, { bindings: [inputBinding('fractionElapsed', () => -0.5)] });
    expect(screen.getByTestId('pulse-ring-progress').getAttribute('stroke-dasharray')).toMatch(/^0[ ,]/);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('clamps a fraction above 1 to a full ring', async () => {
    await render(PulseRingComponent, { bindings: [inputBinding('fractionElapsed', () => 1.5)] });
    const circle = screen.getByTestId('pulse-ring-progress');
    const [drawn, total] = circle.getAttribute('stroke-dasharray')!.split(/[ ,]/).map(Number);
    expect(drawn).toBeCloseTo(total, 1);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('treats a non-finite fraction as 0 instead of producing NaN attributes', async () => {
    await render(PulseRingComponent, { bindings: [inputBinding('fractionElapsed', () => NaN)] });
    expect(screen.getByTestId('pulse-ring-progress').getAttribute('stroke-dasharray')).toMatch(/^0[ ,]/);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });
});
