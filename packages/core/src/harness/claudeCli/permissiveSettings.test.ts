import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findPermissiveSettingsWarning } from './permissiveSettings.js';

function claudeDir(directory: string): string {
  const dir = join(directory, '.claude');
  mkdirSync(dir);
  return dir;
}

describe('findPermissiveSettingsWarning', () => {
  it('returns undefined when the directory has no .claude settings', () => {
    const directory = mkdtempSync(join(tmpdir(), 'of-project-'));

    expect(findPermissiveSettingsWarning(directory)).toBeUndefined();
  });

  it('warns when settings.json sets permissions.defaultMode to bypassPermissions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'of-project-'));
    writeFileSync(join(claudeDir(directory), 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));

    expect(findPermissiveSettingsWarning(directory)).toMatch(/bypassPermissions/);
  });

  it('warns when settings.local.json sets permissions.defaultMode to bypassPermissions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'of-project-'));
    writeFileSync(join(claudeDir(directory), 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));

    expect(findPermissiveSettingsWarning(directory)).toMatch(/bypassPermissions/);
  });

  it('warns when settings.json defines a PermissionRequest hook', () => {
    const directory = mkdtempSync(join(tmpdir(), 'of-project-'));
    writeFileSync(
      join(claudeDir(directory), 'settings.json'),
      JSON.stringify({ hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo allow' }] }] } }),
    );

    expect(findPermissiveSettingsWarning(directory)).toMatch(/PermissionRequest/);
  });

  it('warns when settings.json defines a PreToolUse hook', () => {
    const directory = mkdtempSync(join(tmpdir(), 'of-project-'));
    writeFileSync(
      join(claudeDir(directory), 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo allow' }] }] } }),
    );

    expect(findPermissiveSettingsWarning(directory)).toMatch(/PreToolUse/);
  });

  it('does not warn on a defaultMode other than bypassPermissions and no auto-approving hooks', () => {
    const directory = mkdtempSync(join(tmpdir(), 'of-project-'));
    writeFileSync(join(claudeDir(directory), 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }));

    expect(findPermissiveSettingsWarning(directory)).toBeUndefined();
  });

  it('ignores a malformed settings file instead of throwing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'of-project-'));
    writeFileSync(join(claudeDir(directory), 'settings.json'), '{not json');

    expect(findPermissiveSettingsWarning(directory)).toBeUndefined();
  });

  describe('a malformed settings file', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('logs a warning naming the unreadable file instead of being silently skipped', () => {
      const directory = mkdtempSync(join(tmpdir(), 'of-project-'));
      const settingsPath = join(claudeDir(directory), 'settings.json');
      writeFileSync(settingsPath, '{not json');

      findPermissiveSettingsWarning(directory);

      expect(warnSpy).toHaveBeenCalledWith(`could not parse ${settingsPath}, not checked`);
    });
  });
});
