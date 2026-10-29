import { describe, expect, it } from 'vitest';
import { configDirHarnessRefusalOf } from './configDir.js';

describe('configDirHarnessRefusalOf', () => {
  it.each(['claude-cli', 'fake'])('accepts a config_dir for the %s harness', (harness) => {
    expect(configDirHarnessRefusalOf(harness)).toBeUndefined();
  });

  it('refuses a config_dir for a harness that has no config directory, naming the harness', () => {
    expect(configDirHarnessRefusalOf('codex')).toBe('harness codex does not support config_dir');
  });
});
