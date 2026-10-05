import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { ThemeService } from '../core/theme.service';
import { ThemeToggleButtonComponent } from '../design/theme-toggle-button.component';

/** Sidebar footer: who you are, the theme toggle, and the only visible entry to Settings (the gear, also ⌘,). */
@Component({
  selector: 'of-sidebar-footer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, ThemeToggleButtonComponent],
  template: `
    <footer class="footer" data-testid="sidebar-footer">
      <span class="avatar" aria-hidden="true">YO</span>
      <span class="name">You</span>
      <of-theme-toggle-button [theme]="themeService.theme()" (toggled)="themeService.toggle()" />
      <button
        type="button"
        class="gear"
        data-testid="settings-gear"
        aria-label="Settings"
        title="Settings (⌘,)"
        routerLink="/settings"
        routerLinkActive
        #settingsRoute="routerLinkActive"
        [attr.aria-pressed]="settingsRoute.isActive"
      >⚙</button>
    </footer>
  `,
  styles: `
    .footer { flex: none; display: flex; align-items: center; gap: .5rem; padding: .5rem .75rem; border-top: 1px solid var(--line); }
    .avatar { flex: none; width: 1.75rem; height: 1.75rem; border-radius: 50%; background: var(--accent-bg); color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: .6875rem; font-weight: 600; }
    .name { flex: 1; min-width: 0; font-weight: 500; }
    .gear { flex: none; width: 1.75rem; height: 1.75rem; border: 1px solid transparent; border-radius: .375rem; background: transparent; color: var(--mut); font-size: .875rem; cursor: pointer; outline: 0; }
    .gear:hover { background: var(--hover); color: var(--fg); }
    .gear:focus-visible { box-shadow: 0 0 0 2px var(--accent); }
    .gear[aria-pressed='true'] { border-color: var(--accent); background: var(--accent-bg); color: var(--accent); }
  `,
})
export class SidebarFooterComponent {
  protected readonly themeService = inject(ThemeService);
}
