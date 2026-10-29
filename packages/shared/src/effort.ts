const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** The effort levels each harness id accepts at launch. A harness absent from the table has no effort to set. */
export const EFFORT_LEVELS_BY_HARNESS: Readonly<Record<string, readonly string[]>> = {
  'claude-cli': CLAUDE_EFFORT_LEVELS,
  fake: CLAUDE_EFFORT_LEVELS,
};

/** Returns why the harness refuses this effort, or undefined when it accepts it. */
export function effortRefusalOf(harness: string, effort: string): string | undefined {
  const acceptedLevels = EFFORT_LEVELS_BY_HARNESS[harness];
  if (acceptedLevels === undefined) return `harness ${harness} does not support effort`;
  if (acceptedLevels.includes(effort)) return undefined;
  return `effort ${JSON.stringify(effort)} is not valid for harness ${harness}; valid values: ${acceptedLevels.join(', ')}`;
}
