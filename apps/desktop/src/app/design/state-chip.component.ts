import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import type { SessionState } from '@openfleet/shared';
import { elapsedLabel, elapsedSecondsSince } from './elapsed-time';

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
      [attr.data-live]="look().live && !stale() ? '1' : null"
      [attr.data-errblink]="look().errBlink ? '1' : null"
      [attr.data-stale]="stale() ? '1' : null"
      [style.background]="'color-mix(in oklch, var(' + look().colorVar + ') 14%, transparent)'"
      class="chip"
    ><span [style.color]="'var(' + look().colorVar + ')'">{{ look().icon }}</span><span data-testid="state-chip-label" style="color: var(--fg)">{{ look().label }}{{ detail() ? ' · ' + detail() : '' }}</span>@if (elapsedDisplay(); as elapsed) {<span data-testid="state-chip-elapsed" class="elapsed">{{ elapsed }}</span>}</span>
  `,
  styles: `
    .chip {
      display: inline-flex; align-items: center; gap: .375rem;
      height: 1.5rem; padding: 0 .5rem; border-radius: .375rem;
      font-family: var(--mono); font-size: .75rem; font-weight: 500;
    }
    .elapsed { color: var(--mut); }
  `,
})
export class StateChipComponent {
  readonly state = input.required<string>();
  readonly stale = input(false);
  readonly since = input<string | undefined>(undefined);
  /** A short qualifier written after the label, such as "exit 1". */
  readonly detail = input<string | undefined>(undefined);
  /** Draws the chip in the error colour and blinks it, whatever its state. */
  readonly isFailure = input(false);
  private readonly now = signal(Date.now());

  constructor() {
    const tick = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  private readonly stateLook = computed((): ChipLook => {
    const state = this.state();
    return Object.hasOwn(LOOK, state)
      ? LOOK[state as ChipState]
      : { icon: '?', label: state, colorVar: '--state-closed', live: false, errBlink: false };
  });

  protected readonly look = computed((): ChipLook => {
    const look = this.stateLook();
    return this.isFailure() ? { ...look, colorVar: '--state-error', live: false, errBlink: true } : look;
  });

  protected readonly elapsedDisplay = computed(() => {
    const since = this.since();
    return since ? elapsedLabel(elapsedSecondsSince(since, this.now())) : null;
  });
}
