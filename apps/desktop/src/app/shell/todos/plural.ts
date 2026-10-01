/** Picks the singular for exactly one, the plural otherwise. */
export function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}
