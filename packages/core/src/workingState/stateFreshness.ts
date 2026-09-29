import type { WorkingState } from '@openfleet/shared';

const MINUTE_MS = 60_000;

export const ageMsOf = (state: WorkingState, nowIso: string): number => Date.parse(nowIso) - Date.parse(state.updatedAt);

export const isOlderThanLimit = (ageMs: number, maxAgeMinutes: number): boolean => ageMs > maxAgeMinutes * MINUTE_MS;

export const isWrittenBeforeFleetChanged = (state: WorkingState): boolean => state.fleetChangedAt !== undefined && state.updatedAt < state.fleetChangedAt;

export const ageInWholeMinutes = (ageMs: number): number => Math.floor(ageMs / MINUTE_MS);

export const minutesLabel = (minutes: number): string => (minutes === 1 ? `${minutes} minute` : `${minutes} minutes`);
