import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';

export function markDirectoryTrusted(configPath: string, directory: string): void {
  const realDirectory = existsSync(directory) ? realpathSync(directory) : directory;
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  config.projects ??= {};
  config.projects[realDirectory] = { ...config.projects[realDirectory], hasTrustDialogAccepted: true };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}
