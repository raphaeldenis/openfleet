import { describe, expect, it } from 'vitest';
import { usageIngestionEnabledBy } from './usageIngestionEnv.js';

describe('usageIngestionEnabledBy', () => {
  it('enables the ingestion only for the exact value 1', () => {
    expect(usageIngestionEnabledBy({ OPENFLEET_USAGE_INGESTION: '1' })).toBe(true);
  });

  it.each([undefined, '', '0', 'true', 'yes', 'on', ' 1', '1 ', '11', '01'])('leaves the ingestion off for %j', (value) => {
    expect(usageIngestionEnabledBy({ OPENFLEET_USAGE_INGESTION: value })).toBe(false);
  });

  it('leaves the ingestion off when the variable is absent', () => {
    expect(usageIngestionEnabledBy({})).toBe(false);
  });
});
