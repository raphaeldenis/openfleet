export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

const isTokenCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Reads the daemon's answer; anything but two token counts reads as "no data", never as zero. */
export function parseTokenUsage(body: unknown): TokenUsage | null {
  const isObject = body !== null && typeof body === 'object';
  if (!isObject) return null;
  const { inputTokens, outputTokens } = body as Record<string, unknown>;
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) return null;
  return { inputTokens, outputTokens };
}
