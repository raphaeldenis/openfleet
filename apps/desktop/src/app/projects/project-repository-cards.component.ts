import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { Project } from '@openfleet/shared';
import { ProjectEscalationSettingComponent } from './project-escalation-setting.component';
import { ProjectHookSettingComponent } from './project-hook-setting.component';
import { ProjectWorktreesComponent } from './project-worktrees.component';

/** The cards about a project's repositories: its worktrees and its post-create hook. The Project home loads this file on demand. */
@Component({
  selector: 'of-project-repository-cards',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProjectEscalationSettingComponent, ProjectHookSettingComponent, ProjectWorktreesComponent],
  template: `
    <of-project-worktrees [projectId]="project().id" />
    <of-project-hook-setting [project]="project()" (saved)="onProjectSaved()($event)" />
    <of-project-escalation-setting [project]="project()" (saved)="onProjectSaved()($event)" />
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 1rem; }
  `,
})
export class ProjectRepositoryCardsComponent {
  readonly project = input.required<Project>();
  /** Called with the project the daemon returns after the hook is saved. */
  readonly onProjectSaved = input.required<(saved: Project) => void>();
}
