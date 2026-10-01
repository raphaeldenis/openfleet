import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { environment } from '../../environments/environment';
import { detailsTextOf } from '../core/copy-details';
import { copyOfDaemonIssue } from '../core/error-copy';
import { FleetEventsService } from '../core/fleet-events.service';
import { VersionsService } from '../core/versions.service';
import { BannerComponent } from '../design/banner.component';
import { CopyDetailsButtonComponent } from '../design/copy-details-button.component';
import { SessionListComponent } from '../sessions/session-list.component';
import { attentionItemsOf, inboxCountLabelOf } from '../working-state/attention-items';
import { CommandPaletteComponent } from './command-palette.component';
import { DaemonStatusComponent } from './daemon-status.component';
import { HELM_NAV_ITEMS } from './nav-items';
import { RightPanelComponent, RightPanelToggleComponent } from './right-panel.component';

const RUNNING_STATES = new Set(['generating', 'starting']);

@Component({
  selector: 'of-app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, RouterOutlet, SessionListComponent, DaemonStatusComponent, CommandPaletteComponent, BannerComponent, CopyDetailsButtonComponent, RightPanelComponent, RightPanelToggleComponent],
  template: `
    <div class="shell" data-testid="app-shell">
      <div class="body" [attr.inert]="paletteOpen() ? '' : null">
        <nav class="sidebar" data-testid="app-nav">
          <div class="brand">OpenFleet</div>
          <section class="sessions">
            <div class="section-title"><span>Sessions</span><span class="mono">{{ runningCount() }} running</span></div>
            <of-session-list (selected)="onSessionSelected($event)" />
          </section>
          <ul class="helm-list">
            @for (item of navItems; track item.key) {
              <li>
                @if (item.route) {
                  <a class="nav-item" [routerLink]="item.route" routerLinkActive="active" [attr.data-testid]="'nav-' + item.key">
                    <span class="glyph">{{ item.glyph }}</span><span class="label">{{ item.label }}</span>
                    @if (item.key === 'inbox' && inboxBadge(); as badge) {
                      <span class="nav-badge" data-testid="nav-inbox-badge" role="img" [attr.aria-label]="badge.ariaLabel">{{ badge.text }}</span>
                    }
                    @if (item.key === 'inbox' && hasBackgroundFailures()) {
                      <span class="nav-issue-dot" data-testid="nav-inbox-issue-dot" role="img" aria-label="Inbox has issues"></span>
                    }
                  </a>
                } @else {
                  <span class="nav-item disabled" aria-disabled="true" [title]="item.availability" [attr.data-testid]="'nav-' + item.key">
                    <span class="glyph">{{ item.glyph }}</span><span class="label">{{ item.label }}</span>
                    <span class="availability">{{ item.availability }}</span>
                  </span>
                }
              </li>
            }
          </ul>
        </nav>
        <div class="main-column">
          <header class="topbar" data-testid="app-topbar">
            <span class="brand-mark">OpenFleet</span>
            <button type="button" class="of-input search-trigger" data-testid="open-palette" #paletteTrigger (click)="openPalette()">
              <span>⌕</span><span class="placeholder">Search or run a command…</span><span class="shortcut mono">⌘K</span>
            </button>
            <span class="spacer"></span>
            <of-right-panel-toggle />
            <of-daemon-status [connected]="events.connected()" />
            <span class="spend" data-testid="spend-today" title="Cost tracking is not implemented yet">— today</span>
          </header>
          @if (!events.connected()) {
            <of-banner
              variant="reconnecting"
              title="↻ Reconnecting to daemon"
              description="Sessions keep running; the UI shows the last known state."
            />
          }
          @if (degraded(); as state) {
            <of-banner
              data-testid="degraded-banner"
              variant="error"
              title="The daemon hit a problem and is running degraded"
              [description]="state.description"
            >
              <of-copy-details-button testId="degraded-copy-details" [text]="state.detailsText" />
            </of-banner>
          }
          @if (versions.mismatch(); as mismatch) {
            <of-banner
              data-testid="version-mismatch-banner"
              variant="mismatch"
              title="Version mismatch"
              [description]="'The daemon on ' + daemonAddress + ' is ' + mismatch.daemonVersion + ', this app is ' + mismatch.appVersion"
            />
          }
          <main class="outlet" data-testid="app-outlet">
            <router-outlet />
          </main>
        </div>
        <of-right-panel />
      </div>
      <footer class="statusbar" data-testid="app-statusbar" [attr.inert]="paletteOpen() ? '' : null">
        <of-daemon-status [connected]="events.connected()" />
        <span class="mono">{{ daemonAddress }}</span>
        <span class="spacer"></span>
        <span class="limits" data-testid="status-limits" title="Provider limits are not tracked yet">—</span>
      </footer>
      <of-command-palette [open]="paletteOpen()" [sessionEpoch]="paletteEpoch()" (closed)="closePalette()" />
    </div>
  `,
  styles: `
    .shell { display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 75rem; position: relative; overflow: hidden; }
    .body { flex: 1; min-height: 0; display: flex; }
    .sidebar { width: 17.5rem; flex: none; display: flex; flex-direction: column; background: var(--side); border-right: 1px solid var(--line); min-height: 0; overflow-y: auto; }
    .brand { height: 2.75rem; flex: none; display: flex; align-items: center; padding: 0 .875rem; font-weight: 600; letter-spacing: -.01em; border-bottom: 1px solid var(--line); }
    .sessions { flex-grow: 2; flex-shrink: 1; flex-basis: 0; min-height: 0; overflow: hidden; display: flex; flex-direction: column; border-bottom: 1px solid var(--line); }
    .section-title { display: flex; align-items: center; gap: .375rem; height: 1.875rem; padding: 0 .75rem; font-size: .6875rem; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--mut); }
    .section-title .mono { margin-left: auto; font-family: var(--mono); font-weight: 400; letter-spacing: 0; color: var(--faint); }
    .helm-list { flex-grow: 1.4; flex-shrink: 1; flex-basis: 0; min-height: 0; list-style: none; margin: 0; padding: .375rem; display: flex; flex-direction: column; gap: 1px; overflow-y: auto; }
    .nav-item { display: flex; align-items: center; gap: .5rem; height: 1.75rem; padding: 0 .5rem; border-radius: .375rem; color: var(--fg); }
    .nav-badge { flex: none; min-width: 1rem; height: 1rem; padding: 0 .25rem; border-radius: .5rem; background: var(--accent); color: var(--on-accent); font-size: .625rem; font-weight: 600; display: flex; align-items: center; justify-content: center; }
    .nav-issue-dot { flex: none; width: .5rem; height: .5rem; border-radius: 50%; background: var(--state-error); }
    a.nav-item { cursor: pointer; }
    a.nav-item:hover, a.nav-item:focus-visible { background: var(--hover); }
    a.nav-item.active { background: var(--active); }
    .nav-item.disabled { color: var(--faint); }
    .nav-item .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .nav-item .glyph { width: 1rem; text-align: center; font-family: var(--mono); font-size: .75rem; }
    .nav-item .availability { font-size: .625rem; color: var(--faint); white-space: nowrap; }
    .main-column { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
    .topbar { height: 2.75rem; flex: none; display: flex; align-items: center; gap: .75rem; padding: 0 .875rem; border-bottom: 1px solid var(--line); background: var(--panel); }
    .brand-mark { font-weight: 600; }
    .search-trigger { flex: none; width: 22rem; display: flex; align-items: center; gap: .5rem; color: var(--faint); cursor: pointer; }
    .search-trigger .placeholder { flex: 1; text-align: left; }
    .search-trigger .shortcut { font-size: .6875rem; padding: 0 .3125rem; border: 1px solid var(--line-2); border-radius: .25rem; }
    .spacer { flex: 1; }
    .spend { font-family: var(--mono); font-size: .75rem; color: var(--mut); font-style: italic; }
    .outlet { flex: 1; min-height: 0; min-width: 0; display: flex; overflow-y: auto; overflow-x: hidden; }
    .statusbar { flex: none; height: 1.625rem; display: flex; align-items: center; gap: .75rem; padding: 0 .75rem; border-top: 1px solid var(--line); background: var(--side); font-size: .6875rem; color: var(--mut); }
    .limits { font-style: italic; }
    .mono { font-family: var(--mono); }
    /* Terminal-first collapse order at 1200×800 (handoff Q10): status bar details, then header
       density — there is no persistent right panel yet in this shell to collapse first. */
    @media (max-width: 75rem) {
      .statusbar .limits { display: none; }
      .search-trigger .placeholder { display: none; }
      .search-trigger { width: auto; }
    }
  `,
})
export class AppShellComponent {
  protected readonly events = inject(FleetEventsService);
  protected readonly versions = inject(VersionsService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  protected readonly navItems = HELM_NAV_ITEMS;
  protected readonly daemonAddress = environment.daemonAddress;
  protected readonly paletteOpen = signal(false);
  protected readonly paletteEpoch = signal(0);
  protected readonly runningCount = computed(() => this.events.sessions().filter((s) => RUNNING_STATES.has(s.state)).length);
  protected readonly inboxBadge = computed(() => {
    const attentionCount = attentionItemsOf(this.events.sessions(), this.events.workingStates()).length;
    const itemsNeedingYou = this.events.approvals().length + attentionCount;
    return itemsNeedingYou > 0 ? inboxCountLabelOf(itemsNeedingYou) : undefined;
  });
  /** Issues inform rather than ask for a decision, so they get a dot and stay out of the count of items needing you. */
  protected readonly hasBackgroundFailures = computed(() => this.events.backgroundFailures().length > 0);
  protected readonly degraded = computed(() => {
    const issues = this.events.daemonIssues();
    const [firstIssue, ...otherIssues] = issues;
    if (!firstIssue) return undefined;
    const daemonVersion = this.versions.daemonVersion();
    const othersNote = otherIssues.length > 0 ? ` (+${otherIssues.length} more)` : '';
    const description = `${copyOfDaemonIssue(firstIssue)}${othersNote}.`;
    const detailsText = issues
      .map((issue) => detailsTextOf({ ref: issue.id, code: issue.code, message: issue.message, at: issue.since, daemonVersion }))
      .join('\n\n');
    return { description, detailsText };
  });
  private readonly paletteTrigger = viewChild.required<ElementRef<HTMLButtonElement>>('paletteTrigger');
  private paletteOpener: HTMLElement | null = null;

  constructor() {
    void this.versions.loadAppVersion();
  }

  onSessionSelected(sessionId: string): void {
    void this.router.navigate(['/session', sessionId]);
  }

  openPalette(): void {
    this.paletteEpoch.update((epoch) => epoch + 1);
    const active = document.activeElement;
    const hasFocusedOpener = active instanceof HTMLElement && active !== document.body;
    this.paletteOpener = hasFocusedOpener ? active : null;
    this.paletteOpen.set(true);
  }

  closePalette(): void {
    if (!this.paletteOpen()) return;
    this.paletteOpen.set(false);
    const opener = this.paletteOpener;
    const focusTarget = opener?.isConnected ? opener : this.paletteTrigger().nativeElement;
    this.paletteOpener = null;
    // The `.body`/statusbar `[attr.inert]` binding only clears once change detection renders this
    // signal write, so focusing synchronously here is a silent no-op: the target is still inside
    // an inert subtree. Wait for that render before moving focus.
    afterNextRender(() => focusTarget.focus(), { injector: this.injector });
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const isCommandOrCtrlK = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
    if (isCommandOrCtrlK) {
      event.preventDefault();
      if (this.paletteOpen()) this.closePalette();
      else this.openPalette();
      return;
    }
    if (event.key === 'Escape' && this.paletteOpen()) {
      this.closePalette();
    }
  }
}
