import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';

interface ClaudeConfig { projects?: Record<string, { hasTrustDialogAccepted?: boolean } & Record<string, unknown>> }

const NEW_FILE_MODE = 0o600;

export function markDirectoryTrusted(configPath: string, directory: string): void {
  const realDirectory = existsSync(directory) ? realpathSync(directory) : directory;
  if (readConfig(configPath).projects?.[realDirectory]?.hasTrustDialogAccepted) return;

  // Re-read right before writing to narrow the window against a concurrent writer (another
  // daemon session, or the user's own `claude` process) clobbering changes we haven't seen.
  // ponytail: still not atomic across processes — no cross-process lock. A write racing exactly
  // between this re-read and the rename below can still be lost. Fine for a single-user local daemon.
  const config = readConfig(configPath);
  config.projects ??= {};
  config.projects[realDirectory] = { ...config.projects[realDirectory], hasTrustDialogAccepted: true };

  const originalMode = existsSync(configPath) ? statSync(configPath).mode & 0o777 : NEW_FILE_MODE;
  const tempPath = `${configPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(config, null, 2));
  chmodSync(tempPath, originalMode);
  renameSync(tempPath, configPath);
}

function readConfig(configPath: string): ClaudeConfig {
  return existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
}
