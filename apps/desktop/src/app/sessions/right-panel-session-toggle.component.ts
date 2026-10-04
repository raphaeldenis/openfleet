import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RIGHT_PANEL_HIDE_TITLE, RIGHT_PANEL_SHOW_TITLE, RightPanelState } from '../core/right-panel-state';

/** The ◨ button of the session terminal tab bar: it shows the state of the right panel and toggles it. */
@Component({
  selector: 'of-right-panel-session-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" class="toggle" data-testid="right-panel-session-toggle"
            aria-label="Right panel" aria-controls="right-panel" aria-keyshortcuts="Alt+Meta+B"
            [attr.title]="state.open() ? hideTitle : showTitle"
            [attr.aria-pressed]="state.open()" (click)="state.toggle()">◨</button>
  `,
  styles: `
    .toggle { width: 1.75rem; height: 1.75rem; flex: none; border: 1px solid rgba(255, 255, 255, .18); border-radius: .375rem; background: transparent; color: var(--term-fg); font-size: .875rem; cursor: pointer; }
    .toggle[aria-pressed='true'] { border-color: var(--accent); color: var(--accent); background: color-mix(in oklch, var(--accent) 18%, transparent); }
    .toggle:hover { background: rgba(255, 255, 255, .08); }
    .toggle:focus-visible { outline: 0; box-shadow: 0 0 0 2px var(--accent); }
  `,
})
export class RightPanelSessionToggleComponent {
  protected readonly state = inject(RightPanelState);
  protected readonly showTitle = RIGHT_PANEL_SHOW_TITLE;
  protected readonly hideTitle = RIGHT_PANEL_HIDE_TITLE;
}
