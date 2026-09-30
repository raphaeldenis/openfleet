export interface BootRefusalOutput { configPath: string; writeStderr: (text: string) => void; exit: (code: number) => never }

const firstLineOf = (text: string) => text.split('\n')[0]!;

// A boot that throws before the daemon listens is a refusal: one readable fatal line and a non-zero exit,
// never the runtime 'daemon continuing' net (which would swallow it and exit 0).
export async function refuseBootOnFailure<T>(boot: () => Promise<T>, output: BootRefusalOutput): Promise<T> {
  try {
    return await boot();
  } catch (error) {
    const reason = firstLineOf(error instanceof Error ? error.message : String(error));
    output.writeStderr(`openfleet: refusing to boot (config: ${output.configPath}): ${reason}\n`);
    return output.exit(1);
  }
}
