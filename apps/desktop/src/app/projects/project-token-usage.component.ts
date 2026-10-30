import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, untracked } from '@angular/core';
import { ProjectUsageService } from '../core/project-usage.service';
import { TokenUsageComponent } from '../design/token-usage.component';

const REFRESH_PERIOD_MS = 60_000;

/** The tokens a project has used today: read again when the project or the state of one of its sessions changes, and every minute while the page is visible. */
@Component({
  selector: 'of-project-token-usage',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TokenUsageComponent],
  template: `<span class="today"><span class="today-label">Today</span> <of-token-usage [usage]="usage()" /></span>`,
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

  protected readonly usage = () => this.usages.todayOf(this.projectId())();

  constructor() {
    effect(() => {
      const projectId = this.projectId();
      this.sessionStates();
      untracked(() => void this.usages.refresh(projectId));
    });
    const everyMinute = setInterval(() => this.refreshWhenPageIsVisible(), REFRESH_PERIOD_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(everyMinute));
  }

  private refreshWhenPageIsVisible(): void {
    const isPageVisible = document.visibilityState === 'visible';
    if (isPageVisible) void this.usages.refresh(this.projectId());
  }
}
