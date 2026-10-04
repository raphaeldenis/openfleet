import { describe, expect, it } from 'vitest';
import { versionMismatchNoticeOf } from './version-mismatch-notice';

const NOTICE_INPUT = {
  mismatch: { appVersion: '1.2.0', daemonVersion: '0.9.2' },
  address: '127.0.0.1:7331',
  at: '2026-10-03T14:12:00.000Z',
  ref: 'OF-ab12cd',
};

describe('versionMismatchNoticeOf', () => {
  it('names both versions and the daemon address in the sentence', () => {
    const { description } = versionMismatchNoticeOf(NOTICE_INPUT);

    expect(description).toBe('The daemon on 127.0.0.1:7331 is 0.9.2, this app is 1.2.0 — restart the daemon so both match.');
  });

  it('carries the reference, both versions, the address and the time in the details to paste', () => {
    const { detailsText } = versionMismatchNoticeOf(NOTICE_INPUT);

    expect(detailsText).toContain('OF-ab12cd');
    expect(detailsText).toContain('version_mismatch');
    expect(detailsText).toContain('daemon: 0.9.2');
    expect(detailsText).toContain('app: 1.2.0');
    expect(detailsText).toContain('address: 127.0.0.1:7331');
    expect(detailsText).toContain('time: 2026-10-03T14:12:00.000Z');
  });
});
