import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FleetApiService } from '../core/fleet-api.service';

const MODEL_RUNGS = ['haiku', 'sonnet', 'opus', 'fable'] as const;

@Component({
  selector: 'of-new-manager-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <form (ngSubmit)="submit()">
      <h3>New manager</h3>
      <input data-testid="manager-directory" name="managerDirectory" [(ngModel)]="directory" placeholder="/path/to/worktree" required />
      <input data-testid="manager-name" name="managerName" [(ngModel)]="name" placeholder="Name" required />
      <input data-testid="manager-emoji" name="managerEmoji" [(ngModel)]="emoji" size="2" />
      <select data-testid="manager-model" name="managerModel" [(ngModel)]="model">
        @for (rung of modelRungs; track rung) {
          <option [value]="rung">{{ rung }}</option>
        }
      </select>
      <input data-testid="manager-pulse-seconds" name="pulseSeconds" type="number" [(ngModel)]="pulseSeconds" placeholder="Pulse seconds" required />
      <input data-testid="manager-children-cap" name="childrenCap" type="number" [(ngModel)]="childrenCap" placeholder="Children cap" required />
      <textarea data-testid="manager-mission" name="mission" [(ngModel)]="mission" placeholder="Mission" required></textarea>
      <button type="submit" class="of-btn of-btn--primary" data-testid="create-manager">+ New manager</button>
    </form>
  `,
  styles: `
    form { display: flex; flex-direction: column; gap: .4rem; padding: .6rem }
  `,
})
export class NewManagerFormComponent {
  private readonly api = inject(FleetApiService);
  protected readonly modelRungs = MODEL_RUNGS;
  directory = '';
  name = '';
  emoji = '🧭';
  model: string = 'sonnet';
  pulseSeconds = 1800;
  childrenCap = 2;
  mission = '';

  async submit(): Promise<void> {
    await this.api.createManagerSession({
      directory: this.directory,
      name: this.name,
      emoji: this.emoji,
      model: this.model,
      pulseSeconds: this.pulseSeconds,
      childrenCap: this.childrenCap,
      mission: this.mission,
    });
    this.name = '';
    this.mission = '';
  }
}
