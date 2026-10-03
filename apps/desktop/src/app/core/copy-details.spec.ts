import { describe, expect, it } from 'vitest';
import { detailsTextOf } from './copy-details';

const HOSTILE = 'open /Users/review-user/private; Authorization: Bearer SYNTHETIC_TOKEN_123; safe‮evil​';

describe('detailsTextOf', () => {
  it('lists the ref, the code, the message, the daemon version and the time', () => {
    const text = detailsTextOf({ ref: '3f9a1c2e', code: 'db_stuck', message: 'The database is stuck.', at: '2026-09-30T10:00:00.000Z', daemonVersion: '1.2.3' });

    expect(text).toBe(['ref 3f9a1c2e', 'code: db_stuck', 'message: The database is stuck.', 'daemon: 1.2.3', 'time: 2026-09-30T10:00:00.000Z'].join('\n'));
  });

  it('lists the app version and the address between the daemon version and the time, and leaves the message out when there is none', () => {
    const text = detailsTextOf({ ref: 'OF-5e21b7', code: 'version_mismatch', at: 't', daemonVersion: '0.9.2', appVersion: '1.2.0', address: '127.0.0.1:7331' });

    expect(text).toBe(['ref OF-5e21b7', 'code: version_mismatch', 'daemon: 0.9.2', 'app: 1.2.0', 'address: 127.0.0.1:7331', 'time: t'].join('\n'));
  });

  it('omits the daemon line when the version is unknown', () => {
    const text = detailsTextOf({ code: 'db_stuck', message: 'm', at: 't', daemonVersion: null });

    expect(text).not.toContain('daemon:');
  });

  describe.each(['message', 'code', 'ref', 'daemonVersion'] as const)('the %s field', (field) => {
    const details = detailsTextOf({ code: 'c', message: 'm', at: 't', ref: 'r', daemonVersion: 'v', [field]: HOSTILE });

    it('is stripped of credentials and absolute home paths', () => {
      expect(details).not.toMatch(/SYNTHETIC_TOKEN_123|review-user/);
    });

    it('shows invisible and bidirectional characters as escapes', () => {
      expect(details).toContain('safe<U+202E>evil<U+200B>');
      expect(details).not.toMatch(/[‮​]/);
    });
  });
});
