import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { SessionState } from '@openfleet/shared';

// 'thinking' and 'error' are not in SESSION_STATES yet (see the plan's "Known
// backend gaps" section) — the chip must still render them sensibly.
export type ChipState = SessionState | 'thinking' | 'error';

interface ChipLook { icon: string; label: string; colorVar: string; live: boolean; errBlink: boolean }

const LOOK: Record<ChipState, ChipLook> = {
  starting: { icon: '◌', label: 'starting', colorVar: '--state-closed', live: false, errBlink: false },
  generating: { icon: '▶', label: 'generating', colorVar: '--state-generating', live: true, errBlink: false },
  thinking: { icon: '◐', label: 'thinking', colorVar: '--state-thinking', live: true, errBlink: false },
  waiting_permission: { icon: '!', label: 'waiting permission', colorVar: '--state-waiting-permission', live: false, errBlink: false },
  waiting_input: { icon: '?', label: 'waiting input', colorVar: '--state-waiting-input', live: false, errBlink: false },
  idle: { icon: '○', label: 'idle', colorVar: '--state-idle', live: false, errBlink: false },
  closed: { icon: '■', label: 'closed', colorVar: '--state-closed', live: false, errBlink: false },
  error: { icon: '✕', label: 'error', colorVar: '--state-error', live: false, errBlink: true },
};

@Component({
  selector: 'of-state-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      data-testid="state-chip"
      [attr.data-state]="state()"
      [attr.data-live]="look().live ? '1' : null"
      [attr.data-errblink]="look().errBlink ? '1' : null"
      [attr.data-stale]="stale() ? '1' : null"
      [style.background]="'color-mix(in oklch, var(' + look().colorVar + ') 14%, transparent)'"
      class="chip"
    ><span [style.color]="'var(' + look().colorVar + ')'">{{ look().icon }}</span><span data-testid="state-chip-label" style="color: var(--fg)">{{ look().label }}</span></span>
  `,
  styles: `
    .chip {
      display: inline-flex; align-items: center; gap: .375rem;
      height: 1.5rem; padding: 0 .5rem; border-radius: .375rem;
      font-family: var(--mono); font-size: .75rem; font-weight: 500;
    }
  `,
})
export class StateChipComponent {
  readonly state = input.required<string>();
  readonly stale = input(false);
  protected readonly look = computed((): ChipLook => {
    const state = this.state();
    return LOOK[state as ChipState] ?? { icon: '?', label: state, colorVar: '--state-closed', live: false, errBlink: false };
  });
}
