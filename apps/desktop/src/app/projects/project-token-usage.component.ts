import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, untracked } from '@angular/core';
import { ProjectUsageService } from '../core/project-usage.service';
import { TokenUsageComponent } from '../design/token-usage.component';

const REFRESH_PERIOD_MS = 60_000;

/** The tokens a project has used on the current UTC day: read again when the project or the state of one of its sessions changes, when the page becomes visible, and every minute while it is visible. */
@Component({
  selector: 'of-project-token-usage',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TokenUsageComponent],
  template: `<span class="today" title="Tokens used by this project since 00:00 UTC"><span class="today-label">Today (UTC)</span> <of-token-usage [usage]="usage()" /></span>`,
  styles: `
    :host { display: inline; }
    .today { display: inline-flex; align-items: baseline; gap: .375rem; white-space: nowrap; }
    .today-label { color: var(--mut); font-size: .75rem; }
  `,
})
export class ProjectTokenUsageComponent {
  readonly projectId = input.required<string>();
  /** Changes whenever a session of the project changes state, which ends a turn. */
  readonly sessionStates = input.required<string>();
  private readonly usages = inject(ProjectUsageService);

  protected readonly usage = computed(() => this.usages.todayOf(this.projectId())());

  constructor() {
    effect(() => {
      const projectId = this.projectId();
      this.sessionStates();
      untracked(() => void this.usages.refresh(projectId));
    });
    const refreshTimer = setInterval(() => this.refreshWhenPageIsVisible(), REFRESH_PERIOD_MS);
    const onVisibilityChange = () => this.refreshWhenPageIsVisible();
    document.addEventListener('visibilitychange', onVisibilityChange);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(refreshTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    });
  }

  private refreshWhenPageIsVisible(): void {
    const isPageVisible = document.visibilityState === 'visible';
    if (isPageVisible) void this.usages.refresh(this.projectId());
  }
}
