import { Component, signal } from '@angular/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PopoverComponent } from './popover.component';

@Component({
  imports: [PopoverComponent],
  template: `
    <main data-testid="app-outlet">
      <of-popover triggerTestId="trigger" triggerLabel="Permissions" [width]="width()">
        <span popoverTrigger>Permissions</span>
        <ng-template><button data-initial-focus>Keep asking</button></ng-template>
      </of-popover>
    </main>
  `,
})
class PopoverHost {
  readonly width = signal('352px');
}

describe('PopoverComponent positioning', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { outletRight: 500, anchorLeft: 450, expectedLeft: '-162px', expectedMaxWidth: '204px' },
    { outletRight: 1000, anchorLeft: 950, expectedLeft: '-310px', expectedMaxWidth: '704px' },
  ])('limits the panel to an outlet ending at $outletRight', async ({ outletRight, anchorLeft, expectedLeft, expectedMaxWidth }) => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const isOutlet = this.dataset['testid'] === 'app-outlet';
      const left = isOutlet ? 280 : anchorLeft;
      const requestedWidth = parseFloat(this.style.width) || 100;
      const panelWidth = Math.min(requestedWidth, parseFloat(this.style.maxWidth) || requestedWidth);
      const width = isOutlet ? outletRight - left : panelWidth;
      return { left, right: left + width, width, top: 0, bottom: 24, height: 24, x: left, y: 0, toJSON: () => ({}) };
    });
    await render(PopoverHost);

    await userEvent.click(screen.getByTestId('trigger'));

    const safeAnswer = await screen.findByRole('button', { name: 'Keep asking' });
    await waitFor(() => expect(safeAnswer.parentElement).toHaveStyle({ left: expectedLeft, maxWidth: expectedMaxWidth }));
  });

  it('repositions when the panel grows or the outlet resizes and restores focus on Escape', async () => {
    let outletRight = 1000;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const isOutlet = this.dataset['testid'] === 'app-outlet';
      const left = isOutlet ? 280 : 900;
      const width = isOutlet ? outletRight - left : parseFloat(this.style.width) || 100;
      return { left, right: left + width, width, top: 0, bottom: 24, height: 24, x: left, y: 0, toJSON: () => ({}) };
    });
    const { fixture } = await render(PopoverHost);

    await userEvent.click(screen.getByTestId('trigger'));

    const safeAnswer = await screen.findByRole('button', { name: 'Keep asking' });
    const panel = safeAnswer.parentElement!;
    await waitFor(() => expect(panel.style.left).toBe('-260px'));
    expect(safeAnswer).toHaveFocus();

    fixture.componentInstance.width.set('384px');
    await fixture.whenStable();
    await waitFor(() => expect(panel.style.left).toBe('-292px'));

    outletRight = 950;
    fireEvent(window, new Event('resize'));
    await waitFor(() => expect(panel.style.left).toBe('-342px'));
    await userEvent.keyboard('{Escape}');
    expect(screen.getByTestId('trigger')).toHaveFocus();
  });
});
