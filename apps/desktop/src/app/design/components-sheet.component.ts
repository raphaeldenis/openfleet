import { ChangeDetectionStrategy, Component } from '@angular/core';
import { StateChipComponent, type ChipState } from './state-chip.component';
import { KindBadgeComponent, type InboxKind } from './kind-badge.component';
import { BannerComponent, type BannerVariant } from './banner.component';
import { PulseRingComponent } from './pulse-ring.component';

const STATES: ChipState[] = ['starting', 'generating', 'thinking', 'waiting_permission', 'waiting_input', 'idle', 'closed', 'error'];
const KINDS: InboxKind[] = ['gate', 'question', 'law', 'permission', 'resource'];
const BANNERS: { variant: BannerVariant; title: string; description: string }[] = [
  { variant: 'permission', title: '! Permission needed', description: 'Inline in the terminal and mirrored to Inbox.' },
  { variant: 'reconnecting', title: '↻ Reconnecting', description: 'Sessions keep running; UI shows last known state.' },
  { variant: 'error', title: '✕ Error', description: 'Say what failed, what is unaffected, and the next step.' },
  { variant: 'done', title: '✓ Done', description: 'Short confirmation, then get out of the way.' },
];

@Component({
  selector: 'of-components-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StateChipComponent, KindBadgeComponent, BannerComponent, PulseRingComponent],
  template: `
    <div class="sheet">
      <h1>Component sheet</h1>
      <section class="row">
        @for (state of states; track state) { <of-state-chip [state]="state" /> }
      </section>
      <section class="row">
        @for (kind of kinds; track kind) { <of-kind-badge [kind]="kind" /> }
      </section>
      <section class="col">
        @for (b of banners; track b.variant) {
          <of-banner [variant]="b.variant" [title]="b.title" [description]="b.description" />
        }
      </section>
      <section class="row">
        <of-pulse-ring [fractionElapsed]="0.3" />
        <button class="of-btn of-btn--primary" data-testid="sheet-btn-primary">Primary</button>
        <button class="of-btn of-btn--secondary" data-testid="sheet-btn-secondary">Secondary</button>
        <button class="of-btn of-btn--link" data-testid="sheet-btn-link">Link</button>
        <button class="of-btn of-btn--primary" disabled data-testid="sheet-btn-disabled">Disabled</button>
      </section>
    </div>
  `,
  styles: `
    .sheet { display: flex; flex-direction: column; gap: 1.5rem; padding: 1.5rem; }
    .row { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; }
    .col { display: flex; flex-direction: column; gap: .625rem; }
  `,
})
export class ComponentsSheetComponent {
  protected readonly states = STATES;
  protected readonly kinds = KINDS;
  protected readonly banners = BANNERS;
}
