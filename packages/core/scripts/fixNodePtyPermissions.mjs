import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// node-pty's published prebuilds lose the executable bit on spawn-helper
// somewhere in the npm pack/publish → pnpm extract pipeline (reproduced on
// pnpm 12 / node-pty 1.1.0 / darwin-arm64: posix_spawnp failed on every
// ClaudeCliHarness.start, even for a trivial /bin/echo). Restoring it here
// so a fresh `pnpm install` (dev machine or CI) always produces a working
// PTY spawn — chmod on the store is not something git or the lockfile can
// carry for us.
const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function spawnHelpersUnder(nodeModulesDir) {
  const helpers = [];
  const pnpmDir = join(nodeModulesDir, '.pnpm');
  const packageDirs = existsSync(pnpmDir)
    ? readdirSync(pnpmDir).filter((name) => name.startsWith('node-pty@')).map((name) => join(pnpmDir, name, 'node_modules', 'node-pty'))
    : [join(nodeModulesDir, 'node-pty')];
  for (const packageDir of packageDirs) {
    const prebuildsDir = join(packageDir, 'prebuilds');
    if (!existsSync(prebuildsDir)) continue;
    for (const platform of readdirSync(prebuildsDir)) {
      const helper = join(prebuildsDir, platform, 'spawn-helper');
      if (existsSync(helper)) helpers.push(helper);
    }
  }
  return helpers;
}

for (const helper of spawnHelpersUnder(join(workspaceRoot, 'node_modules'))) {
  chmodSync(helper, 0o755);
}
