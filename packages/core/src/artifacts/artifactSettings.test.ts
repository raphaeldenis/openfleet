import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirTracker } from '../tempDirTracker.js';
import { DEFAULT_ARTIFACT_SETTINGS, loadArtifactSettings } from './artifactSettings.js';

const tempDirs = createTempDirTracker();
afterEach(() => tempDirs.removeAll());

const KIBIBYTE = 1024;

function configWith(artifacts: Record<string, unknown>): string {
  const configPath = join(tempDirs.make('of-artifact-settings-'), 'config.json');
  writeFileSync(configPath, JSON.stringify({ artifacts }));
  return configPath;
}

describe('the artifact file size limit', () => {
  it('defaults to 256 KiB, which a hook body can carry', () => {
    expect(DEFAULT_ARTIFACT_SETTINGS.maxFileBytes).toBe(256 * KIBIBYTE);
  });

  it('accepts a configured maximum up to 512 KiB', () => {
    const settings = loadArtifactSettings(configWith({ maxFileBytes: 512 * KIBIBYTE }));

    expect(settings.maxFileBytes).toBe(512 * KIBIBYTE);
  });

  it('ignores a maximum above 512 KiB, no hook body could carry such a Write, and keeps the defaults', () => {
    const settings = loadArtifactSettings(configWith({ maxFileBytes: 512 * KIBIBYTE + 1 }));

    expect(settings).toEqual(DEFAULT_ARTIFACT_SETTINGS);
  });
});
