import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { markDirectoryTrusted } from './trustDirectory.js';

describe('markDirectoryTrusted', () => {
  it('creates a project entry with hasTrustDialogAccepted when the config file does not exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'of-claude-home-'));
    const configPath = join(home, '.claude.json');
    const directory = mkdtempSync(join(tmpdir(), 'of-project-'));
    const realDirectory = realpathSync(directory);

    markDirectoryTrusted(configPath, directory);

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.projects[realDirectory].hasTrustDialogAccepted).toBe(true);
  });

  it('preserves sibling keys on an existing project entry', () => {
    const home = mkdtempSync(join(tmpdir(), 'of-claude-home-'));
    const configPath = join(home, '.claude.json');
    const directory = mkdtempSync(join(tmpdir(), 'of-project-'));
    const realDirectory = realpathSync(directory);
    writeFileSync(configPath, JSON.stringify({ numStartups: 3, projects: { [realDirectory]: { allowedTools: ['Bash'], hasTrustDialogAccepted: false } } }));

    markDirectoryTrusted(configPath, directory);

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.numStartups).toBe(3);
    expect(config.projects[realDirectory]).toEqual({ allowedTools: ['Bash'], hasTrustDialogAccepted: true });
  });

  it('keys the entry by the real path, resolving a ".." segment', () => {
    const home = mkdtempSync(join(tmpdir(), 'of-claude-home-'));
    const configPath = join(home, '.claude.json');
    const directory = mkdtempSync(join(tmpdir(), 'of-project-'));
    const realDirectory = realpathSync(directory);

    markDirectoryTrusted(configPath, join(directory, '..', directory.split('/').pop()!));

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.projects[realDirectory].hasTrustDialogAccepted).toBe(true);
  });

  it('skips writing the file when the directory is already trusted', async () => {
    const home = mkdtempSync(join(tmpdir(), 'of-claude-home-'));
    const configPath = join(home, '.claude.json');
    const directory = mkdtempSync(join(tmpdir(), 'of-project-'));
    const realDirectory = realpathSync(directory);
    writeFileSync(configPath, JSON.stringify({ projects: { [realDirectory]: { hasTrustDialogAccepted: true } } }));
    const mtimeBefore = statSync(configPath).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 5));

    markDirectoryTrusted(configPath, directory);

    expect(statSync(configPath).mtimeMs).toBe(mtimeBefore);
  });

  it('writes atomically via a temp file and rename when trust is newly granted', () => {
    const home = mkdtempSync(join(tmpdir(), 'of-claude-home-'));
    const configPath = join(home, '.claude.json');
    const directory = mkdtempSync(join(tmpdir(), 'of-project-'));
    const realDirectory = realpathSync(directory);
    writeFileSync(configPath, JSON.stringify({ projects: {} }));
    const inodeBefore = statSync(configPath).ino;

    markDirectoryTrusted(configPath, directory);

    expect(statSync(configPath).ino).not.toBe(inodeBefore);
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.projects[realDirectory].hasTrustDialogAccepted).toBe(true);
  });
});
