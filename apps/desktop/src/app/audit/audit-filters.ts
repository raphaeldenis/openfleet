import { ACTIVITY_ACTOR_KINDS, ACTIVITY_OUTCOMES, DEFAULT_ACTIVITY_PAGE_LIMIT, type ActivityRow } from '@openfleet/shared';
import type { ActivityQueryParams } from '../core/fleet-api.service';

export type AuditPeriod = 'lastHour' | 'last24Hours' | 'last7Days' | 'last30Days' | 'allTime';

export interface AuditFilters {
  readonly actor: ActivityRow['actorKind'] | '';
  readonly outcome: ActivityRow['outcome'] | '';
  readonly action: string;
  readonly period: AuditPeriod;
}

const MS_PER_HOUR = 3_600_000;

export const AUDIT_PERIODS: ReadonlyArray<{ period: AuditPeriod; label: string; hours: number | null }> = [
  { period: 'lastHour', label: 'Last hour', hours: 1 },
  { period: 'last24Hours', label: 'Last 24 hours', hours: 24 },
  { period: 'last7Days', label: 'Last 7 days', hours: 24 * 7 },
  { period: 'last30Days', label: 'Last 30 days', hours: 24 * 30 },
  { period: 'allTime', label: 'All time', hours: null },
];

export const AUDIT_ACTORS = ACTIVITY_ACTOR_KINDS;
export const AUDIT_OUTCOMES = ACTIVITY_OUTCOMES;

export const DEFAULT_AUDIT_FILTERS: AuditFilters = { actor: '', outcome: '', action: '', period: 'last24Hours' };

export const hasNonDefaultFilter = (filters: AuditFilters): boolean => (Object.keys(DEFAULT_AUDIT_FILTERS) as Array<keyof AuditFilters>).some((key) => filters[key] !== DEFAULT_AUDIT_FILTERS[key]);

/** The member of `allowed` that `value` names, or the empty choice ("all") when it names none. */
export function choiceOf<T extends string>(allowed: readonly T[], value: string): T | '' {
  return allowed.find((member) => member === value) ?? '';
}

export function periodOf(value: string): AuditPeriod {
  return AUDIT_PERIODS.find(({ period }) => period === value)?.period ?? DEFAULT_AUDIT_FILTERS.period;
}

function lowerBoundOf(period: AuditPeriod, now: Date): string | undefined {
  const hours = AUDIT_PERIODS.find((candidate) => candidate.period === period)?.hours ?? null;
  return hours === null ? undefined : new Date(now.getTime() - hours * MS_PER_HOUR).toISOString();
}

/** Builds the GET /api/activity query of the filters as of `now`; an empty filter is left out and `cursor` asks for the page after it. */
export function activityQueryOf({ filters, now, cursor }: { filters: AuditFilters; now: Date; cursor?: string }): ActivityQueryParams {
  const since = lowerBoundOf(filters.period, now);
  return {
    limit: DEFAULT_ACTIVITY_PAGE_LIMIT,
    ...(filters.actor === '' ? {} : { actor: filters.actor }),
    ...(filters.outcome === '' ? {} : { outcome: filters.outcome }),
    ...(filters.action === '' ? {} : { action: filters.action }),
    ...(since === undefined ? {} : { since }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}
