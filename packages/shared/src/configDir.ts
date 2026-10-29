/** The harness ids whose CLI reads its account profile from a config directory. A harness absent from the list has none. `fake` is the test harness. */
export const CONFIG_DIR_HARNESSES: readonly string[] = ['claude-cli', 'fake'];

/** Returns why the harness refuses a config_dir, or undefined when it accepts one. */
export function configDirHarnessRefusalOf(harness: string): string | undefined {
  return CONFIG_DIR_HARNESSES.includes(harness) ? undefined : `harness ${harness} does not support config_dir`;
}
