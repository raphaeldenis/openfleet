import { PortInUseError } from './api/portInUseError.js';
import { ConfigFileError } from './configFileError.js';
import { readableConfigReason } from './configReason.js';

export interface BootRefusalOutput { configPath: string; writeStderr: (text: string) => void; exit: (code: number) => never }

const MAX_REASON_LENGTH = 200;
// DATABASE_OPEN_FAILED: the database file exists but sqlite cannot open it. ENOTEMPTY: a directory a recursive removal could not empty because a child was not removable.
const PERMISSION_TROUBLE_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOTEMPTY', 'DATABASE_OPEN_FAILED']);

const firstLineOf = (text: string) => text.split('\n')[0]!;
const withoutControlCharacters = (text: string) => text.replace(/\p{Cc}/gu, '');

function errnoOf(error: unknown): { code?: unknown; path?: unknown } {
  return typeof error === 'object' && error !== null ? error : {};
}

function recoveryHintOf(error: unknown): string | undefined {
  const { code, path } = errnoOf(error);
  if (error instanceof PortInUseError) return 'stop the other process or set OPENFLEET_PORT';
  if (code === 'ERR_SOCKET_BAD_PORT') return 'set OPENFLEET_PORT to a port between 0 and 65535';
  const isUnreadablePath = typeof code === 'string' && PERMISSION_TROUBLE_CODES.has(code) && typeof path === 'string';
  return isUnreadablePath ? `check the permissions of ${path}` : undefined;
}

function refusalLineOf(error: unknown, configPath: string): string {
  const origin = error instanceof ConfigFileError ? ` (config: ${configPath})` : '';
  const hint = recoveryHintOf(error);
  const hintSuffix = hint === undefined ? '' : ` (${hint})`;
  const reason = withoutControlCharacters(firstLineOf(readableConfigReason(error))).slice(0, MAX_REASON_LENGTH);
  return withoutControlCharacters(`openfleet: refusing to boot${origin}: ${reason}${hintSuffix}`);
}

// A boot that throws is a refusal: one readable fatal line and a non-zero exit, never the runtime
// 'daemon continuing' net (which would swallow it and exit 0). The line points at config.json only
// when reading it is what failed.
export async function refuseBootOnFailure<T>(boot: () => Promise<T>, output: BootRefusalOutput): Promise<T> {
  try {
    return await boot();
  } catch (error) {
    output.writeStderr(`${refusalLineOf(error, output.configPath)}\n`);
    return output.exit(1);
  }
}
