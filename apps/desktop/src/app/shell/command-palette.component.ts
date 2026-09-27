import { afterRenderEffect, ChangeDetectionStrategy, Component, ElementRef, inject, input, output, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { PALETTE_PAGES } from './nav-items';

@Component({
  selector: 'of-command-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <div data-testid="command-palette" class="backdrop" (click)="closed.emit()" (keydown)="trapTab($event)">
        <div class="panel" #panel role="dialog" aria-modal="true" aria-label="Command palette" (click)="stopPropagation($event)">
          <div class="search-row"><span>⌕</span><span class="placeholder">Jump to a page</span><span class="hint">esc</span></div>
          <div class="group-label">Pages</div>
          <ul class="items">
            @for (page of pages; track page.key) {
              <li>
                <button type="button" [attr.data-testid]="'palette-item-' + page.key" (click)="go(page.route)">
                  <span class="icon">{{ page.icon }}</span><span>{{ page.label }}</span>
                </button>
              </li>
            }
          </ul>
        </div>
      </div>
    }
  `,
  styles: `
    .backdrop { position: absolute; inset: 0; background: rgba(10, 10, 14, .32); display: flex; justify-content: center; align-items: flex-start; padding-top: 6rem; z-index: 50; }
    .panel { width: 25rem; max-height: 20rem; display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--line-2); border-radius: .75rem; box-shadow: var(--shadow); overflow: hidden; }
    .search-row { display: flex; align-items: center; gap: .625rem; padding: .75rem 1rem; border-bottom: 1px solid var(--line); color: var(--faint); }
    .placeholder { flex: 1; }
    .hint { font-family: var(--mono); font-size: .6875rem; }
    .group-label { padding: .5rem .875rem .25rem; font-size: .6875rem; font-weight: 600; color: var(--faint); letter-spacing: .04em; text-transform: uppercase; }
    .items { list-style: none; margin: 0; padding: 0 .375rem .375rem; display: flex; flex-direction: column; gap: .125rem; }
    .items button { display: flex; align-items: center; gap: .625rem; height: 2rem; padding: 0 .625rem; border: 0; border-radius: .375rem; background: transparent; color: var(--fg); font: inherit; text-align: left; width: 100%; cursor: pointer; }
    .items button:hover, .items button:focus-visible { background: var(--hover); }
    .icon { width: 1.25rem; text-align: center; }
  `,
})
export class CommandPaletteComponent {
  readonly open = input.required<boolean>();
  readonly closed = output<void>();
  private readonly router = inject(Router);
  protected readonly pages = PALETTE_PAGES;
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');

  constructor() {
    afterRenderEffect(() => {
      if (this.open()) this.focusFirstItem();
    });
  }

  focusFirstItem(): void {
    this.focusableElements()[0]?.focus();
  }

  trapTab(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const focusables = this.focusableElements();
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const isShiftTabOnFirst = event.shiftKey && document.activeElement === first;
    const isTabOnLast = !event.shiftKey && document.activeElement === last;
    if (isShiftTabOnFirst) {
      event.preventDefault();
      last.focus();
    } else if (isTabOnLast) {
      event.preventDefault();
      first.focus();
    }
  }

  go(route: string): void {
    void this.router.navigate([route]);
    this.closed.emit();
  }

  stopPropagation(event: Event): void {
    event.stopPropagation();
  }

  private focusableElements(): HTMLElement[] {
    const panel = this.panel()?.nativeElement;
    if (!panel) return [];
    return Array.from(panel.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])'));
  }
}
