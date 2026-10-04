import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { markDirectoryTrusted } from './trustDirectory.js';

function createScratchDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function readTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files[path] = readFileSync(path, 'utf8');
    }
  };
  walk(root);
  return files;
}

describe('markDirectoryTrusted', () => {
  it('creates a project entry with hasTrustDialogAccepted when the config file does not exist', () => {
    const home = createScratchDirectory('of-claude-home-');
    const configPath = join(home, '.claude.json');
    const directory = createScratchDirectory('of-project-');
    const realDirectory = realpathSync(directory);

    markDirectoryTrusted(configPath, directory);

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.projects[realDirectory].hasTrustDialogAccepted).toBe(true);
  });

  it('preserves sibling keys on an existing project entry', () => {
    const home = createScratchDirectory('of-claude-home-');
    const configPath = join(home, '.claude.json');
    const directory = createScratchDirectory('of-project-');
    const realDirectory = realpathSync(directory);
    writeFileSync(configPath, JSON.stringify({ numStartups: 3, projects: { [realDirectory]: { allowedTools: ['Bash'], hasTrustDialogAccepted: false } } }));

    markDirectoryTrusted(configPath, directory);

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.numStartups).toBe(3);
    expect(config.projects[realDirectory]).toEqual({ allowedTools: ['Bash'], hasTrustDialogAccepted: true });
  });

  it('keys the entry by the real path, resolving a ".." segment', () => {
    const home = createScratchDirectory('of-claude-home-');
    const configPath = join(home, '.claude.json');
    const directory = createScratchDirectory('of-project-');
    const realDirectory = realpathSync(directory);

    markDirectoryTrusted(configPath, join(directory, '..', directory.split('/').pop()!));

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.projects[realDirectory].hasTrustDialogAccepted).toBe(true);
  });

  it('skips writing the file when the directory is already trusted', async () => {
    const home = createScratchDirectory('of-claude-home-');
    const configPath = join(home, '.claude.json');
    const directory = createScratchDirectory('of-project-');
    const realDirectory = realpathSync(directory);
    writeFileSync(configPath, JSON.stringify({ projects: { [realDirectory]: { hasTrustDialogAccepted: true } } }));
    const mtimeBefore = statSync(configPath).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 5));

    markDirectoryTrusted(configPath, directory);

    expect(statSync(configPath).mtimeMs).toBe(mtimeBefore);
  });

  it('writes atomically via a temp file and rename when trust is newly granted', () => {
    const home = createScratchDirectory('of-claude-home-');
    const configPath = join(home, '.claude.json');
    const directory = createScratchDirectory('of-project-');
    const realDirectory = realpathSync(directory);
    writeFileSync(configPath, JSON.stringify({ projects: {} }));
    const inodeBefore = statSync(configPath).ino;

    markDirectoryTrusted(configPath, directory);

    expect(statSync(configPath).ino).not.toBe(inodeBefore);
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.projects[realDirectory].hasTrustDialogAccepted).toBe(true);
  });

  it('preserves the original file mode across the atomic rewrite', () => {
    const home = createScratchDirectory('of-claude-home-');
    const configPath = join(home, '.claude.json');
    const directory = createScratchDirectory('of-project-');
    writeFileSync(configPath, JSON.stringify({ projects: {} }));
    chmodSync(configPath, 0o600);

    markDirectoryTrusted(configPath, directory);

    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('user can trust a project directory without a single file of that directory changing, and leaves nothing but the config file in the config folder', () => {
    const home = createScratchDirectory('of-claude-home-');
    const configPath = join(home, '.claude.json');
    const directory = createScratchDirectory('of-project-');
    mkdirSync(join(directory, '.claude'));
    writeFileSync(join(directory, '.claude', 'settings.local.json'), '{"hooks":{}}');
    writeFileSync(join(directory, 'README.md'), 'hello');
    const projectBefore = readTree(directory);

    markDirectoryTrusted(configPath, directory);

    expect(readTree(directory)).toEqual(projectBefore);
    expect(readdirSync(home)).toEqual(['.claude.json']);
  });

  it('keeps the original mode of an existing file that is not 0600', () => {
    const home = createScratchDirectory('of-claude-home-');
    const configPath = join(home, '.claude.json');
    const directory = createScratchDirectory('of-project-');
    writeFileSync(configPath, '{}');
    chmodSync(configPath, 0o640);

    markDirectoryTrusted(configPath, directory);

    expect(statSync(configPath).mode & 0o777).toBe(0o640);
  });

  it('lands the trust entries of two writers one after the other', () => {
    const home = createScratchDirectory('of-claude-home-');
    const configPath = join(home, '.claude.json');
    const firstDirectory = createScratchDirectory('of-project-');
    const secondDirectory = createScratchDirectory('of-project-');

    markDirectoryTrusted(configPath, firstDirectory);
    markDirectoryTrusted(configPath, secondDirectory);

    const { projects } = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(Object.keys(projects).sort()).toEqual([realpathSync(firstDirectory), realpathSync(secondDirectory)].sort());
  });

  it('lands every trust entry when several callers start writes in one process', async () => {
    const home = createScratchDirectory('of-claude-home-');
    const configPath = join(home, '.claude.json');
    const writerCount = 8;
    const projectsRoot = createScratchDirectory('of-projects-');
    const directories = Array.from({ length: writerCount }, (_, index) => {
      const directory = join(projectsRoot, `project-${index}`);
      mkdirSync(directory);
      return directory;
    });

    await Promise.all(directories.map(async (directory) => markDirectoryTrusted(configPath, directory)));

    const { projects } = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(Object.keys(projects).sort()).toEqual(directories.map((directory) => realpathSync(directory)).sort());
    expect(readdirSync(home)).toEqual(['.claude.json']);
  });

  it('keeps key order, unknown fields, indentation and the trailing newline of the rest of the file', () => {
    const home = createScratchDirectory('of-claude-home-');
    const configPath = join(home, '.claude.json');
    const directory = createScratchDirectory('of-project-');
    writeFileSync(configPath, '{\n    "zeta": 1,\n    "account": {"id": "a-1", "extra": [1, 2]},\n    "alpha": null,\n    "projects": {\n        "/other": {"b": 1, "a": 2}\n    }\n}\n');

    markDirectoryTrusted(configPath, directory);

    const expected = `{\n    "zeta": 1,\n    "account": {\n        "id": "a-1",\n        "extra": [\n            1,\n            2\n        ]\n    },\n    "alpha": null,\n    "projects": {\n        "/other": {\n            "b": 1,\n            "a": 2\n        },\n        ${JSON.stringify(realpathSync(directory))}: {\n            "hasTrustDialogAccepted": true\n        }\n    }\n}\n`;
    expect(readFileSync(configPath, 'utf8')).toBe(expected);
  });

  it('keeps a compact file compact', () => {
    const home = createScratchDirectory('of-claude-home-');
    const configPath = join(home, '.claude.json');
    const directory = createScratchDirectory('of-project-');
    writeFileSync(configPath, '{"numStartups":3}');

    markDirectoryTrusted(configPath, directory);

    expect(readFileSync(configPath, 'utf8')).toBe(`{"numStartups":3,"projects":{${JSON.stringify(realpathSync(directory))}:{"hasTrustDialogAccepted":true}}}`);
  });

  it.each([
    ['not valid JSON', '{"oauthToken": "sk-secret-value", broken'],
    ['not a JSON object', '["sk-secret-value"]'],
    ['JSON null', 'null'],
  ])('refuses a config file that is %s, leaves it untouched and never echoes its content', (_situation, content) => {
    const home = createScratchDirectory('of-claude-home-');
    const configPath = join(home, '.claude.json');
    const directory = createScratchDirectory('of-project-');
    writeFileSync(configPath, content);

    const failure = (() => { try { markDirectoryTrusted(configPath, directory); } catch (err) { return err as Error; } })();

    expect(failure).toBeInstanceOf(Error);
    expect(JSON.stringify([failure!.message, failure!.cause, (failure as { options?: unknown }).options])).not.toContain('sk-secret-value');
    expect(readFileSync(configPath, 'utf8')).toBe(content);
    expect(readdirSync(home)).toEqual(['.claude.json']);
  });

  it('writes through a symlinked config file and keeps the link', () => {
    const home = createScratchDirectory('of-claude-home-');
    const dotfiles = createScratchDirectory('of-dotfiles-');
    const targetPath = join(dotfiles, 'claude.json');
    const configPath = join(home, '.claude.json');
    writeFileSync(targetPath, '{"numStartups":1}');
    symlinkSync(targetPath, configPath);
    const directory = createScratchDirectory('of-project-');

    markDirectoryTrusted(configPath, directory);

    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(targetPath, 'utf8'))).toMatchObject({ numStartups: 1, projects: { [realpathSync(directory)]: { hasTrustDialogAccepted: true } } });
    expect(readdirSync(dotfiles)).toEqual(['claude.json']);
  });

  it('creates a brand new trust file with mode 0600', () => {
    const home = createScratchDirectory('of-claude-home-');
    const configPath = join(home, '.claude.json');
    const directory = createScratchDirectory('of-project-');

    markDirectoryTrusted(configPath, directory);

    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });
});
