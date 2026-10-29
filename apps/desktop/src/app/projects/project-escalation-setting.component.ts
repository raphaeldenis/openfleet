import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, output, signal } from '@angular/core';
import { DEFAULT_ESCALATION_POLICY, ESCALATING_CLASSES, UNREMOVABLE_ESCALATING_CLASSES, type EscalatingClass, type Project } from '@openfleet/shared';
import { copyFor } from '../core/error-copy';
import { FleetApiService } from '../core/fleet-api.service';
import { ErrorLineComponent } from '../design/error-line.component';

let nextSettingSequence = 0;

const isRemovable = (escalatingClass: EscalatingClass): boolean => !(UNREMOVABLE_ESCALATING_CLASSES as readonly string[]).includes(escalatingClass);

/** Shows which question classes reach the human for a project and lets the user take the removable ones off that list. */
@Component({
  selector: 'of-project-escalation-setting',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorLineComponent],
  template: `
    <section class="card" aria-labelledby="escalation-title">
      <div class="card-head">
        <h2 id="escalation-title" class="card-title">Escalation policy</h2>
      </div>
      <p class="line">Questions of a checked class go to you. The others are decided by the manager with the arbiter.</p>
      <ul class="classes" [attr.aria-busy]="pending() || null">
        @for (row of rows(); track row.name) {
          <li class="class-row">
            <input type="checkbox" class="of-checkbox" [id]="row.fieldId" [checked]="row.isEscalated" [disabled]="!row.isRemovable || pending()" [attr.aria-describedby]="row.isRemovable ? null : row.noteId" (change)="toggle(row.name, $event)" />
            <label [for]="row.fieldId">{{ row.label }}</label>
            @if (!row.isRemovable) {
              <span class="note" [id]="row.noteId">Always escalated</span>
            }
          </li>
        }
      </ul>
      @if (saveFailure(); as failure) {
        <p class="failure"><of-error-line role="alert">{{ failure }}</of-error-line></p>
      }
    </section>
  `,
  styles: `
    :host { display: block; }
    .card { border: 1px solid var(--line); border-radius: .625rem; background: var(--panel); }
    .card-head { display: flex; align-items: center; gap: .5rem; padding: .625rem .875rem; }
    .card-title { margin: 0; font-size: .8125rem; font-weight: 600; }
    .line { margin: 0; padding: 0 .875rem .625rem; font-size: .6875rem; color: var(--mut); }
    .classes { display: flex; flex-direction: column; gap: .5rem; margin: 0; padding: .75rem .875rem; list-style: none; border-top: 1px solid var(--line); background: var(--sunk); }
    .class-row { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; }
    .class-row label { font-size: .8125rem; text-transform: capitalize; }
    .note { font-size: .75rem; color: var(--mut); }
    .failure { margin: 0; padding: .5rem .875rem .75rem; }
  `,
})
export class ProjectEscalationSettingComponent {
  private readonly api = inject(FleetApiService);
  private hasBeenDestroyed = false;

  readonly project = input.required<Project>();
  readonly saved = output<Project>();

  private readonly sequence = nextSettingSequence++;
  protected readonly pending = signal(false);
  protected readonly saveFailure = signal('');

  private readonly policy = computed(() => this.project().escalation ?? DEFAULT_ESCALATION_POLICY);

  protected readonly rows = computed(() => {
    const { humanClasses } = this.policy();
    return ESCALATING_CLASSES.map((name) => ({
      name,
      label: name.replaceAll('_', ' '),
      fieldId: `escalation-class-${this.sequence}-${name}`,
      noteId: `escalation-class-note-${this.sequence}-${name}`,
      isEscalated: humanClasses.includes(name),
      isRemovable: isRemovable(name),
    }));
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.hasBeenDestroyed = true));
  }

  protected async toggle(toggled: EscalatingClass, event: Event): Promise<void> {
    const policy = this.policy();
    (event.target as HTMLInputElement).checked = policy.humanClasses.includes(toggled);
    if (this.pending() || !isRemovable(toggled)) return;
    const humanClasses = ESCALATING_CLASSES.filter((name) => (name === toggled) !== policy.humanClasses.includes(name));
    this.saveFailure.set('');
    this.pending.set(true);
    try {
      const project = await this.api.updateProject(this.project().id, { escalation: { ...policy, humanClasses } });
      if (this.hasBeenDestroyed) return;
      this.saved.emit(project);
    } catch (error) {
      this.saveFailure.set(copyFor(error, { action: 'save_project_escalation' }).text);
    } finally {
      this.pending.set(false);
    }
  }
}
