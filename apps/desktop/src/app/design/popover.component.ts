import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, TemplateRef, afterRenderEffect, contentChild, inject, input, model, viewChild } from '@angular/core';

export type PopoverTone = 'neutral' | 'danger';

const INITIAL_FOCUS_SELECTOR = '[data-initial-focus]';
const FOCUSABLE_SELECTOR = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), [href]';
const OUTLET_MARGIN = 8;

function focusInitialElementOf(panel: HTMLElement): void {
  const initialElement = panel.querySelector<HTMLElement>(INITIAL_FOCUS_SELECTOR);
  (initialElement ?? panel).focus({ preventScroll: true });
}

function nextIndexInCycle({ currentIndex, count, isBackwards }: { currentIndex: number; count: number; isBackwards: boolean }): number {
  const step = isBackwards ? -1 : 1;
  return (currentIndex + step + count) % count;
}

/**
 * A trigger button that opens a panel under it. The panel template is the single projected `<ng-template>`.
 * Escape closes the panel and returns focus to the trigger, a click outside closes it, and an alert dialog panel traps Tab.
 * The element marked `data-initial-focus` inside the panel receives focus when the panel opens.
 */
@Component({
  selector: 'of-popover',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  host: {
    '(document:click)': 'closeWhenClickedOutside($event)',
    '(keydown.escape)': 'closeOnEscape($event)',
    '(keydown)': 'trapTabInsideAlertDialog($event)',
    '(window:resize)': 'positionPanel()',
  },
  template: `
    <button
      #trigger
      type="button"
      class="trigger"
      [class.trigger--danger]="tone() === 'danger'"
      [attr.data-testid]="triggerTestId()"
      [attr.title]="triggerTitle()"
      [attr.aria-label]="triggerLabel()"
      [attr.aria-haspopup]="isAlertDialog() ? 'dialog' : 'listbox'"
      [attr.aria-expanded]="open()"
      [attr.aria-disabled]="disabled() ? 'true' : null"
      (click)="toggle()"
    >
      <ng-content select="[popoverTrigger]" />
      <span class="caret" aria-hidden="true">▾</span>
    </button>
    @if (open()) {
      <div
        #panel
        class="panel"
        [class.panel--alert]="isAlertDialog()"
        tabindex="-1"
        [attr.role]="isAlertDialog() ? 'alertdialog' : null"
        [attr.aria-label]="isAlertDialog() ? panelLabel() : null"
        [style.width]="width()"
      >
        <ng-container [ngTemplateOutlet]="content()" />
      </div>
    }
  `,
  styles: `
    :host { position: relative; display: inline-flex; flex: none; }
    .trigger {
      height: 1.5rem; display: inline-flex; align-items: center; gap: .375rem; padding: 0 .5rem; white-space: nowrap;
      border: 1px solid var(--line); border-radius: .375rem; background: var(--panel); color: var(--fg);
      font-family: var(--mono); font-size: .6875rem; cursor: pointer;
    }
    .trigger--danger {
      border-color: var(--state-error);
      background: color-mix(in oklch, var(--state-error) 12%, transparent);
    }
    .trigger[aria-disabled='true'] { cursor: not-allowed; opacity: .7; }
    .trigger:focus-visible, .panel:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .caret { color: var(--faint); }
    .panel {
      position: absolute; top: 1.875rem; left: 0; z-index: 20; max-width: calc(100vw - 1.5rem);
      display: flex; flex-direction: column; padding: .375rem;
      background: var(--panel); border: 1px solid var(--line-2); border-radius: .5rem; box-shadow: var(--shadow);
      font-size: .8125rem; color: var(--fg);
    }
    .panel--alert {
      z-index: 21; gap: .625rem; padding: .875rem;
      border-color: color-mix(in oklch, var(--state-error) 45%, transparent);
    }
  `,
})
export class PopoverComponent {
  readonly open = model(false);
  readonly triggerTestId = input.required<string>();
  readonly triggerLabel = input.required<string>();
  readonly triggerTitle = input<string>();
  readonly width = input.required<string>();
  readonly tone = input<PopoverTone>('neutral');
  readonly isAlertDialog = input(false);
  readonly panelLabel = input<string>();
  readonly disabled = input(false);

  protected readonly content = contentChild.required(TemplateRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');

  constructor() {
    afterRenderEffect((onCleanup) => {
      this.isAlertDialog();
      this.width();
      const panel = this.panel()?.nativeElement;
      if (!panel) return;
      this.positionPanel();
      focusInitialElementOf(panel);
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() => this.positionPanel());
      observer.observe(this.host.nativeElement);
      const outlet = this.host.nativeElement.closest('main');
      if (outlet) observer.observe(outlet);
      onCleanup(() => observer.disconnect());
    });
  }

  protected positionPanel(): void {
    const panel = this.panel()?.nativeElement;
    if (!panel) return;
    const host = this.host.nativeElement;
    const outlet = host.closest('main');
    const outletBounds = outlet?.getBoundingClientRect();
    const visibleLeft = Math.max(0, outletBounds?.left ?? 0) + OUTLET_MARGIN;
    const visibleRight = Math.min(window.innerWidth, outletBounds?.right ?? window.innerWidth) - OUTLET_MARGIN;
    const availableWidth = visibleRight - visibleLeft;
    if (availableWidth <= 0) return;
    panel.style.maxWidth = `${availableWidth}px`;
    const anchorLeft = host.getBoundingClientRect().left;
    const panelWidth = panel.getBoundingClientRect().width;
    const rightmostLeft = visibleRight - panelWidth;
    const panelLeft = Math.max(visibleLeft, Math.min(anchorLeft, rightmostLeft));
    panel.style.left = `${panelLeft - anchorLeft}px`;
  }

  /** Closes the panel and puts focus back on the trigger. */
  close(): void {
    this.open.set(false);
    this.trigger().nativeElement.focus();
  }

  protected toggle(): void {
    if (this.disabled()) return;
    this.open.update((isOpen) => !isOpen);
  }

  protected closeOnEscape(event: Event): void {
    if (!this.open()) return;
    event.stopPropagation();
    this.close();
  }

  protected closeWhenClickedOutside(event: MouseEvent): void {
    const isClickInside = event.composedPath().includes(this.host.nativeElement);
    if (!this.open() || isClickInside) return;
    this.open.set(false);
  }

  protected trapTabInsideAlertDialog(event: KeyboardEvent): void {
    const panel = this.panel()?.nativeElement;
    const isTabInsideAlertDialog = event.key === 'Tab' && this.isAlertDialog() && panel !== undefined;
    if (!isTabInsideAlertDialog) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusable.length === 0) return;
    event.preventDefault();
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    focusable[nextIndexInCycle({ currentIndex, count: focusable.length, isBackwards: event.shiftKey })]!.focus();
  }
}
