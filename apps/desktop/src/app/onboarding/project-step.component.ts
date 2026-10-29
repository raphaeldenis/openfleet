import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Project } from '@openfleet/shared';
import { ProjectFormComponent } from '../projects/project-form.component';
import { STEP_PANEL_STYLES } from './step-panel.styles';

@Component({
  selector: 'of-project-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ProjectFormComponent],
  template: `
    <section class="step-panel" data-testid="onboarding-step-project">
      <header>
        <span class="kicker">Step 3 of 6 · Project</span>
        <h1>Define the project</h1>
        <p>Sessions run in your repository. Type its path — folder discovery is not available yet.</p>
      </header>
      <form class="project-form" (ngSubmit)="continueToFirstSession()">
        <div class="card">
          @if (savedProject(); as project) {
            <p>Project ready: <strong>{{ project.name }}</strong></p>
          } @else {
            <of-project-form [suggestsDocsFolder]="true" (saved)="projectSaved.emit($event)" (cancelled)="cancelled.emit()" />
          }
          <label class="of-field">
            <span class="of-label">Repository path</span>
            <input class="of-input" name="repositoryPath" [ngModel]="repositoryPath()" (ngModelChange)="repositoryPath.set($event)" placeholder="/path/to/repository" />
          </label>
        </div>
        <div class="footer">
          <span class="footer-note">Next: start your first session</span>
          <button type="submit" class="of-btn of-btn--primary" [disabled]="!canContinueToFirstSession()">Continue</button>
        </div>
      </form>
    </section>
  `,
  styles: [
    STEP_PANEL_STYLES,
    `
    :host { display: contents }
    .of-field { display: flex; flex-direction: column; gap: .25rem }
    .project-form { display: flex; flex-direction: column; gap: 1rem }
    .footer { display: flex; align-items: center; justify-content: space-between }
    .footer-note { font-size: .75rem; color: var(--mut) }
  `,
  ],
})
export class ProjectStepComponent {
  /** The project created in this step, shown instead of the form once it exists. */
  readonly savedProject = input<Project>();
  readonly repositoryPath = model('');

  readonly projectSaved = output<Project>();
  readonly cancelled = output<void>();
  /** Emits when the user asks to move on; only fires once a project is saved and a repository path is typed. */
  readonly continued = output<void>();

  private readonly hasRepositoryPath = computed(() => this.repositoryPath().trim() !== '');
  protected readonly canContinueToFirstSession = computed(() => {
    const hasSavedProject = this.savedProject() !== undefined;
    return this.hasRepositoryPath() && hasSavedProject;
  });

  protected continueToFirstSession(): void {
    if (!this.canContinueToFirstSession()) return;
    this.continued.emit();
  }
}
