import { DestroyRef, inject, signal, type Signal } from '@angular/core';
import { WORKING_STATE_SECTIONS, type WorkingState, type WorkingStateSectionKey } from '@openfleet/shared';

const MINUTE_MS = 60_000;
const TICK_MS = 1000;

export type OverdueReason = 'missing' | 'too_old' | 'fleet_changed' | 'oversize';

export interface FreshnessRules {
  readonly nowMs: number;
  readonly maxAgeMinutes: number | undefined;
  readonly maxBytes: number | undefined;
}

// The headings and the "(rien)" line are the daemon's mirror format: the size limit is measured on that text.
export const SECTION_HEADINGS: Record<WorkingStateSectionKey, string> = {
  plan: 'Plan',
  todo: 'Todo',
  remaining: 'Reste à faire',
  questionsForHuman: "Questions pour l'humain",
  internalQuestions: 'Questions internes',
  blockers: 'Blocages',
};

const NOTHING_LINE = '(rien)';

const renderedSectionOf = (state: WorkingState, key: WorkingStateSectionKey): string => {
  const lines = state[key].length === 0 ? [NOTHING_LINE] : state[key].map((item) => `- ${item}`);
  return `## ${SECTION_HEADINGS[key]}\n${lines.join('\n')}\n`;
};

export function stateSizeInBytes(state: WorkingState): number {
  const rendered = WORKING_STATE_SECTIONS.map((key) => renderedSectionOf(state, key)).join('\n');
  return new TextEncoder().encode(rendered).length;
}

export const ageInWholeMinutes = (state: WorkingState, nowMs: number): number => Math.floor((nowMs - Date.parse(state.updatedAt)) / MINUTE_MS);

export function overdueReasonOf(state: WorkingState | undefined, rules: FreshnessRules): OverdueReason | undefined {
  if (!state) return 'missing';
  const isOlderThanLimit = rules.maxAgeMinutes !== undefined && rules.nowMs - Date.parse(state.updatedAt) > rules.maxAgeMinutes * MINUTE_MS;
  if (isOlderThanLimit) return 'too_old';
  const isWrittenBeforeFleetChanged = state.fleetChangedAt !== undefined && Date.parse(state.updatedAt) < Date.parse(state.fleetChangedAt);
  if (isWrittenBeforeFleetChanged) return 'fleet_changed';
  const isOverSizeLimit = rules.maxBytes !== undefined && stateSizeInBytes(state) > rules.maxBytes;
  return isOverSizeLimit ? 'oversize' : undefined;
}

const minutesLabel = (minutes: number): string => (minutes === 1 ? '1 minute' : `${minutes} minutes`);

export function overdueExplanation(reason: OverdueReason, state: WorkingState | undefined, rules: FreshnessRules): string {
  if (reason === 'missing' || !state) return 'No state recorded';
  if (reason === 'too_old') return `Written ${minutesLabel(ageInWholeMinutes(state, rules.nowMs))} ago, limit ${minutesLabel(rules.maxAgeMinutes ?? 0)}`;
  if (reason === 'fleet_changed') return 'Written before the last spawn or close';
  return `Larger than the ${rules.maxBytes ?? 0} byte limit (${stateSizeInBytes(state)} bytes)`;
}

/** A clock signal that moves every second, so an age-based view flips without waiting for an event. */
export function tickingNow(): Signal<number> {
  const now = signal(Date.now());
  const tick = setInterval(() => now.set(Date.now()), TICK_MS);
  inject(DestroyRef).onDestroy(() => clearInterval(tick));
  return now;
}
