import type { ManagerView } from '@openfleet/shared';

const READ_DAY_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** "Base v2, read on 15 Oct 2026" once the manager read the current base, "Base v3, not read" otherwise; undefined when the daemon reports no base. */
export function baseLineOf({ baseVersion, baseRead }: Pick<ManagerView, 'baseVersion' | 'baseRead'>): string | undefined {
  if (baseVersion === undefined) return undefined;
  const hasReadCurrentBase = baseRead !== undefined && baseRead.version >= baseVersion;
  if (!hasReadCurrentBase) return `Base v${baseVersion}, not read`;
  return `Base v${baseRead.version}, read on ${READ_DAY_FORMAT.format(new Date(baseRead.readAt))}`;
}
