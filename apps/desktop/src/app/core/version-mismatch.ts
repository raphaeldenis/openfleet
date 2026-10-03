export interface VersionMismatch {
  appVersion: string;
  daemonVersion: string;
}

/** Returns both versions when they differ, and null when they match or when either one is unknown. A leading "v" and "+build" metadata do not count as a difference. */
export function versionMismatchOf({ appVersion, daemonVersion }: { appVersion: string | null; daemonVersion: string | null }): VersionMismatch | null {
  const comparableApp = comparableVersionOf(appVersion);
  const comparableDaemon = comparableVersionOf(daemonVersion);
  const isEitherUnknown = comparableApp === '' || comparableDaemon === '';
  if (isEitherUnknown) return null;
  const isSameRelease = comparableApp === comparableDaemon;
  if (isSameRelease) return null;
  return { appVersion: appVersion as string, daemonVersion: daemonVersion as string };
}

function comparableVersionOf(version: string | null): string {
  const withoutBuildMetadata = (version ?? '').split('+')[0] ?? '';
  return withoutBuildMetadata.trim().replace(/^v/i, '');
}
