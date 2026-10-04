import { detailsTextOf } from './copy-details';
import type { VersionMismatch } from './version-mismatch';

export interface VersionMismatchNotice {
  description: string;
  detailsText: string;
}

/** Builds the sentence and the pasteable details of the "Version mismatch" strip. */
export function versionMismatchNoticeOf({ mismatch, address, at, ref }: { mismatch: VersionMismatch; address: string; at: string; ref: string }): VersionMismatchNotice {
  const { daemonVersion, appVersion } = mismatch;
  const description = `The daemon on ${address} is ${daemonVersion}, this app is ${appVersion} — restart the daemon so both match.`;
  const detailsText = detailsTextOf({ ref, code: 'version_mismatch', daemonVersion, appVersion, address, at });
  return { description, detailsText };
}
