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
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';
import { FleetEventsService } from '../core/fleet-events.service';
import { RIGHT_PANEL_HIDE_TITLE, RightPanelState } from '../core/right-panel-state';
import { focusTabAt, nextTabIndex } from '../design/tablist-keyboard';
import { TodosTabComponent } from './todos/todos-tab.component';

const WATCHED_SESSION_URL = /^\/(?:session|manager)\/([^/?#]+)/;

/** Returns the id of the session or manager the route shows, if any. */
export function watchedSessionIdOf(url: string): string | undefined {
  return WATCHED_SESSION_URL.exec(url)?.[1];
}

interface PanelTab { readonly key: string; readonly label: string; readonly enabled: boolean }

const COMING_SOON = 'Coming soon';
const RAIL_TITLE = 'Show the right panel — sessions, todos, usage (⌥⌘B)';
const PANEL_TABS: readonly PanelTab[] = [
  { key: 'sessions', label: 'Sessions', enabled: false },
  { key: 'usage', label: 'Usage', enabled: false },
  { key: 'todos', label: 'Todos', enabled: true },
];

@Component({
  selector: 'of-right-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TodosTabComponent],
  template: `
    @if (!state.open()) {
      <button type="button" class="edge-button rail" data-testid="right-panel-rail" #rail
              aria-controls="right-panel" aria-keyshortcuts="Alt+Meta+B" aria-label="Show the right panel"
              aria-expanded="false" [attr.title]="railTitle" (click)="state.toggle()">‹</button>
    }
    @if (state.open()) {
      <aside class="panel" id="right-panel" data-testid="right-panel" aria-label="Right panel" (keydown.escape)="collapse()">
        <header class="head">
          <div class="tabs" role="tablist" aria-label="Right panel" #tabList (keydown)="onTabKeydown($event)">
            @for (tab of tabs; track tab.key) {
              <button type="button" role="tab" class="tab" [id]="'right-panel-tab-' + tab.key" [attr.data-testid]="'right-panel-tab-' + tab.key"
                      [attr.aria-selected]="tab.key === activeKey()" [attr.aria-disabled]="tab.enabled ? null : 'true'"
                      [attr.aria-controls]="tab.enabled ? 'right-panel-tabpanel' : null" [attr.title]="tab.enabled ? null : comingSoon"
                      [attr.tabindex]="tab.key === activeKey() ? 0 : -1" (click)="activate(tab)">
                <span>{{ tab.label }}</span>
                @if (!tab.enabled) { <span class="soon">{{ comingSoon }}</span> }
              </button>
            }
          </div>
          <button type="button" class="edge-button collapse" data-testid="right-panel-collapse"
                  aria-controls="right-panel" aria-label="Hide the right panel" aria-expanded="true"
                  [attr.title]="hideTitle" (click)="collapse()">›</button>
        </header>
        <div class="tabpanel" role="tabpanel" id="right-panel-tabpanel" aria-labelledby="right-panel-tab-todos">
          <of-todos-tab [sessionId]="watchedSessionId()" [sessionClosed]="watchedSessionClosed()" [connected]="events.connected()" />
        </div>
      </aside>
    }
  `,
  styles: `
    :host { display: flex; flex: none; min-height: 0; }
    .panel { width: 20rem; display: flex; flex-direction: column; min-height: 0; background: var(--side); border-left: 1px solid var(--line); }
    .head { height: 2.75rem; flex: none; display: flex; align-items: center; gap: .25rem; padding: 0 .5rem; border-bottom: 1px solid var(--line); }
    .tabs { flex: 1; min-width: 0; display: flex; gap: .125rem; }
    .tab { display: flex; flex-direction: column; align-items: flex-start; padding: .25rem .5rem; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--mut); font: inherit; font-size: .8125rem; cursor: pointer; }
    .tab[aria-selected='true'] { color: var(--fg); font-weight: 600; border-bottom-color: var(--accent); }
    .tab[aria-disabled='true'] { cursor: not-allowed; }
    .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .soon { font-size: .6875rem; font-weight: 400; color: var(--mut); }
    .edge-button { flex: none; width: 1.375rem; height: 1.375rem; padding: 0; display: flex; align-items: center; justify-content: center; border: 1px solid var(--line-2); border-radius: .375rem; background: var(--panel); color: var(--fg); font: inherit; line-height: 1; cursor: pointer; }
    .edge-button:hover { background: var(--hover); }
    .edge-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .rail { align-self: flex-start; margin: .75rem .25rem 0; }
    .tabpanel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  `,
})
export class RightPanelComponent {
  protected readonly state = inject(RightPanelState);
  protected readonly events = inject(FleetEventsService);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly tabList = viewChild<ElementRef<HTMLElement>>('tabList');
  private readonly rail = viewChild<ElementRef<HTMLButtonElement>>('rail');

  protected readonly railTitle = RAIL_TITLE;
  protected readonly hideTitle = RIGHT_PANEL_HIDE_TITLE;
  protected readonly tabs = PANEL_TABS;
  protected readonly comingSoon = COMING_SOON;
  protected readonly activeKey = signal('todos');

  protected readonly watchedSessionId = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => watchedSessionIdOf(this.router.url)),
    ),
    { initialValue: watchedSessionIdOf(this.router.url) },
  );
  protected readonly watchedSessionClosed = computed(() => {
    const watchedId = this.watchedSessionId();
    return this.events.sessions().some((session) => session.id === watchedId && session.state === 'closed');
  });

  activate(tab: PanelTab): void {
    if (tab.enabled) this.activeKey.set(tab.key);
  }

  collapse(): void {
    this.state.close();
    this.focusRailAfterRender();
  }

  /** The rail only exists once the panel is closed and rendered, so focus waits for that render. */
  private focusRailAfterRender(): void {
    afterNextRender(() => this.rail()?.nativeElement.focus(), { injector: this.injector });
  }

  onTabKeydown(event: KeyboardEvent): void {
    const tabList = this.tabList()?.nativeElement;
    if (!tabList) return;
    const tabElements = Array.from(tabList.querySelectorAll('[role="tab"]'));
    const currentIndex = tabElements.indexOf(event.target as Element);
    const targetIndex = nextTabIndex(event, { currentIndex, tabCount: tabElements.length, orientation: 'horizontal' });
    if (targetIndex === undefined) return;
    event.preventDefault();
    focusTabAt(tabList, targetIndex);
  }

  @HostListener('document:keydown', ['$event'])
  onShortcut(event: KeyboardEvent): void {
    // `key` is a symbol under Option on macOS, so the physical key is matched.
    const isOptionCommandB = event.altKey && event.metaKey && !event.ctrlKey && event.code === 'KeyB';
    if (!isOptionCommandB || event.repeat) return;
    const isBehindAModal = this.host.nativeElement.closest('[inert]') !== null;
    if (isBehindAModal) return;
    event.preventDefault();
    const focusWasInsidePanel = this.host.nativeElement.contains(document.activeElement);
    this.state.toggle();
    if (focusWasInsidePanel && !this.state.open()) this.focusRailAfterRender();
  }
}
