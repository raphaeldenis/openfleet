import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTempDirTracker } from '../tempDirTracker.js';
import { loadDaemonSettings } from '../workingState/workingStateSettings.js';

const directories = createTempDirTracker();
afterAll(() => directories.removeAll());

const configWith = (contents: string | undefined): string => {
  const configPath = join(directories.make('fire-retention-config-'), 'config.json');
  if (contents !== undefined) writeFileSync(configPath, contents);
  return configPath;
};
const fireRetentionDaysOf = (configPath: string) => loadDaemonSettings(configPath).triggers.fireRetentionDays;
const configWithDays = (days: unknown) => configWith(JSON.stringify({ triggers: { fireRetentionDays: days } }));

describe('the operator sets how many days the trigger fires are kept in config.json', () => {
  it('defaults to 90 days without a config file, without the key, and with an empty triggers section', () => {
    expect(fireRetentionDaysOf(configWith(undefined))).toBe(90);
    expect(fireRetentionDaysOf(configWith('{}'))).toBe(90);
    expect(fireRetentionDaysOf(configWith('{"triggers":{}}'))).toBe(90);
  });

  it('reads triggers.fireRetentionDays within 1 to 3650', () => {
    expect(fireRetentionDaysOf(configWithDays(1))).toBe(1);
    expect(fireRetentionDaysOf(configWithDays(30))).toBe(30);
    expect(fireRetentionDaysOf(configWithDays(3650))).toBe(3650);
  });

  it.each([0, -1, 3651, 1.5, '90', null])('refuses to boot on a fireRetentionDays of %s instead of clamping it', (invalid) => {
    expect(() => fireRetentionDaysOf(configWithDays(invalid))).toThrow(/fireRetentionDays|triggers/);
  });

  it.each([
    ['a misspelled fireRetentionDays', '{"triggers":{"fireRetentionDay":30}}'],
    ['a misspelled triggers section', '{"trigger":{"fireRetentionDays":30}}'],
  ])('refuses to boot on %s instead of running on the default', (_label, contents) => {
    expect(() => fireRetentionDaysOf(configWith(contents))).toThrow(/triggers/);
  });
});
