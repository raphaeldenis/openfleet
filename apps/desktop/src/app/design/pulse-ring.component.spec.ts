import { render, screen } from '@testing-library/angular/zoneless';
import { inputBinding } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { PulseRingComponent } from './pulse-ring.component';

describe('PulseRingComponent', () => {
  it('draws a full ring when the pulse just fired', async () => {
    await render(PulseRingComponent, { bindings: [inputBinding('fractionElapsed', () => 0)] });
    const circle = screen.getByTestId('pulse-ring-progress');
    expect(circle.getAttribute('stroke-dasharray')).toMatch(/^0[ ,]/);
  });

  it('draws an empty ring right before the pulse is due', async () => {
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
});
