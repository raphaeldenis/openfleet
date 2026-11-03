export const MAX_CRON_EXPRESSION_CHARS = 100;

export interface CronSchedule {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0 is Sunday; the 7 of the expression is read as 0. */
  daysOfWeek: ReadonlySet<number>;
  isDayOfMonthWildcard: boolean;
  isDayOfWeekWildcard: boolean;
}

export interface CivilDay { month: number; dayOfMonth: number; weekday: number }

interface FieldSpec { min: number; max: number; names?: readonly string[]; firstNameValue?: number }

const MINUTE: FieldSpec = { min: 0, max: 59 };
const HOUR: FieldSpec = { min: 0, max: 23 };
const DAY_OF_MONTH: FieldSpec = { min: 1, max: 31 };
const MONTH: FieldSpec = { min: 1, max: 12, names: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'], firstNameValue: 1 };
const DAY_OF_WEEK: FieldSpec = { min: 0, max: 7, names: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], firstNameValue: 0 };

/** The days of each month, February at its leap length: the longest the month ever is. */
const LONGEST_MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const FIELD_CHARACTERS = /^[0-9A-Za-z*,/\-?]+$/;

function valueOf(token: string, spec: FieldSpec): number | undefined {
  if (/^\d+$/.test(token)) return Number(token);
  const nameIndex = spec.names?.indexOf(token.toUpperCase()) ?? -1;
  return nameIndex < 0 ? undefined : nameIndex + (spec.firstNameValue ?? 0);
}

function rangeOf(base: string, spec: FieldSpec): [number, number] | undefined {
  if (base === '*' || base === '?') return [spec.min, spec.max];
  const [first, last, ...rest] = base.split('-');
  const from = first === undefined ? undefined : valueOf(first, spec);
  const to = last === undefined ? from : valueOf(last, spec);
  const isSound = rest.length === 0 && from !== undefined && to !== undefined && from >= spec.min && to <= spec.max && from <= to;
  return isSound ? [from, to] : undefined;
}

function itemValuesOf(item: string, spec: FieldSpec): number[] | undefined {
  const [base, stepText, ...rest] = item.split('/');
  if (base === undefined || base === '' || rest.length > 0) return undefined;
  const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) ? Number(stepText) : 0;
  const span = spec.max - spec.min + 1;
  const isStepSound = step >= 1 && step <= span;
  const range = rangeOf(base, spec);
  const isSingleValueWithStep = stepText !== undefined && range !== undefined && !base.includes('-') && base !== '*' && base !== '?';
  const [from, to] = isSingleValueWithStep ? [range[0], spec.max] : range ?? [];
  if (!isStepSound || from === undefined || to === undefined) return undefined;
  const values: number[] = [];
  for (let value = from; value <= to; value += step) values.push(value);
  return values;
}

function fieldValuesOf(field: string, spec: FieldSpec): Set<number> | undefined {
  if (!FIELD_CHARACTERS.test(field)) return undefined;
  const values = new Set<number>();
  for (const item of field.split(',')) {
    const itemValues = itemValuesOf(item, spec);
    if (itemValues === undefined) return undefined;
    itemValues.forEach((value) => values.add(value));
  }
  return values;
}

const isWildcard = (field: string): boolean => field.startsWith('*') || field === '?';

/** True when some day of one of the months exists, so the expression fires at least once in a leap cycle. */
function daysOfMonthEverExist(daysOfMonth: ReadonlySet<number>, months: ReadonlySet<number>): boolean {
  return [...months].some((month) => [...daysOfMonth].some((day) => day <= LONGEST_MONTH_DAYS[month - 1]!));
}

/**
 * The schedule of a five-field cron expression; undefined when a field is not valid, or when no day ever matches (the 30th of February).
 * A minute is the finest step, so an expression never fires more than once a minute.
 */
export function cronScheduleOf(expression: string): CronSchedule | undefined {
  if (expression.length > MAX_CRON_EXPRESSION_CHARS) return undefined;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = fields as [string, string, string, string, string];

  const minutes = fieldValuesOf(minuteField, MINUTE);
  const hours = fieldValuesOf(hourField, HOUR);
  const daysOfMonth = fieldValuesOf(dayOfMonthField, DAY_OF_MONTH);
  const months = fieldValuesOf(monthField, MONTH);
  const weekdays = fieldValuesOf(dayOfWeekField, DAY_OF_WEEK);
  if (minutes === undefined || hours === undefined || daysOfMonth === undefined || months === undefined || weekdays === undefined) return undefined;

  const daysOfWeek = new Set([...weekdays].map((day) => day % 7));
  const isDayOfMonthWildcard = isWildcard(dayOfMonthField);
  const isDayOfWeekWildcard = isWildcard(dayOfWeekField);
  const onlyDaysOfMonthDecide = !isDayOfMonthWildcard && isDayOfWeekWildcard;
  if (onlyDaysOfMonthDecide && !daysOfMonthEverExist(daysOfMonth, months)) return undefined;

  return { minutes, hours, daysOfMonth, months, daysOfWeek, isDayOfMonthWildcard, isDayOfWeekWildcard };
}

/** Whether the schedule fires on this day: both day fields must match, or either of them when both are restricted. */
export function daySatisfies(schedule: CronSchedule, day: CivilDay): boolean {
  if (!schedule.months.has(day.month)) return false;
  const matchesDayOfMonth = schedule.daysOfMonth.has(day.dayOfMonth);
  const matchesDayOfWeek = schedule.daysOfWeek.has(day.weekday);
  const bothAreRestricted = !schedule.isDayOfMonthWildcard && !schedule.isDayOfWeekWildcard;
  return bothAreRestricted ? matchesDayOfMonth || matchesDayOfWeek : matchesDayOfMonth && matchesDayOfWeek;
}
