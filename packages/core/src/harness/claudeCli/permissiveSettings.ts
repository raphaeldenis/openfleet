import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SETTINGS_FILE_NAMES = ['settings.json', 'settings.local.json'];
const AUTO_APPROVING_HOOK_EVENTS = ['PreToolUse', 'PermissionRequest'] as const;

interface ClaudeSettings {
  permissions?: { defaultMode?: string };
  hooks?: Partial<Record<(typeof AUTO_APPROVING_HOOK_EVENTS)[number], unknown[]>>;
}

// Read-only: never writes to `directory`. Detects the shape of a permissive config, not a hook's actual
// behaviour — any PreToolUse/PermissionRequest hook is a signal to warn on, since the daemon can't safely
// evaluate an arbitrary script.
export function findPermissiveSettingsWarning(directory: string): string | undefined {
  for (const fileName of SETTINGS_FILE_NAMES) {
    const settingsPath = join(directory, '.claude', fileName);
    if (!existsSync(settingsPath)) continue;
    const settings = tryReadSettings(settingsPath);
    if (!settings) continue;

    if (settings.permissions?.defaultMode === 'bypassPermissions') {
      return `${settingsPath} sets permissions.defaultMode to "bypassPermissions"`;
    }
    const autoApprovingEvent = AUTO_APPROVING_HOOK_EVENTS.find((event) => (settings.hooks?.[event]?.length ?? 0) > 0);
    if (autoApprovingEvent) return `${settingsPath} defines a ${autoApprovingEvent} hook`;
  }
  return undefined;
}

function tryReadSettings(settingsPath: string): ClaudeSettings | undefined {
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    return undefined; // a malformed settings file is not this detector's concern
  }
}
