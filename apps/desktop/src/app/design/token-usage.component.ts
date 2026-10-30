import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { TokenUsageLoad } from '../core/session-usage.service';

const COMPACT_UNITS = [
  { symbol: 'k', size: 1_000 },
  { symbol: 'M', size: 1_000_000 },
  { symbol: 'B', size: 1_000_000_000 },
] as const;
const FIRST_COMPACT_COUNT = 1_000;
const roundedToTenth = (value: number): number => Math.round(value * 10) / 10;

/** Formats a count as 999, 12.3k, 4M or 2.3B, moving up a unit rather than showing 1000k. */
export function compactTokenCount(count: number): string {
  if (count < FIRST_COMPACT_COUNT) return String(count);
  const largestUnit = COMPACT_UNITS[COMPACT_UNITS.length - 1]!;
  const fittingUnit = COMPACT_UNITS.find(({ size }) => roundedToTenth(count / size) < 1_000) ?? largestUnit;
  return `${roundedToTenth(count / fittingUnit.size)}${fittingUnit.symbol}`;
}

const exactCount = (count: number): string => count.toLocaleString('en-US');

/** The input and output tokens of a session as text; no data reads "n/a", never zero. */
@Component({
  selector: 'of-token-usage',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="usage" data-testid="token-usage" role="group" [attr.aria-label]="label()" [attr.title]="label()">{{ text() }}</span>`,
  styles: `
    :host { display: inline; }
    .usage { color: var(--mut); font-family: var(--mono); font-size: .75rem; white-space: nowrap; }
  `,
})
export class TokenUsageComponent {
  /** `undefined` while loading, `null` when the daemon has no usage for the session. */
  readonly usage = input.required<TokenUsageLoad>();

  protected readonly text = computed(() => {
    const usage = this.usage();
    if (usage === undefined) return '…';
    if (usage === null) return 'n/a';
    return `${compactTokenCount(usage.inputTokens)} in / ${compactTokenCount(usage.outputTokens)} out`;
  });
  protected readonly label = computed(() => {
    const usage = this.usage();
    if (usage === undefined) return 'Token usage loading';
    if (usage === null) return 'Token usage not available';
    return `${exactCount(usage.inputTokens)} input tokens, ${exactCount(usage.outputTokens)} output tokens`;
  });
}
