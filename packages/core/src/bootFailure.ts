import { readableConfigReason } from './configReason.js';

export interface BootRefusalOutput { configPath: string; writeStderr: (text: string) => void; exit: (code: number) => never }

const MAX_REASON_LENGTH = 200;

const firstLineOf = (text: string) => text.split('\n')[0]!;
const withoutControlCharacters = (text: string) => text.replace(/\p{Cc}/gu, '');

function reasonLineOf(error: unknown): string {
  const firstLine = firstLineOf(readableConfigReason(error));
  return withoutControlCharacters(firstLine).slice(0, MAX_REASON_LENGTH);
}

// A boot that throws before the daemon listens is a refusal: one readable fatal line and a non-zero exit,
// never the runtime 'daemon continuing' net (which would swallow it and exit 0).
export async function refuseBootOnFailure<T>(boot: () => Promise<T>, output: BootRefusalOutput): Promise<T> {
  try {
    return await boot();
  } catch (error) {
    output.writeStderr(`openfleet: refusing to boot (config: ${output.configPath}): ${reasonLineOf(error)}\n`);
    return output.exit(1);
  }
}
