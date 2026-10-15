import type { ManagerView } from '@openfleet/shared';

const READ_DAY_FORMAT = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

/** "Base v2, lue le 15 oct. 2026" once the manager read the current base, "Base v3, non lue" otherwise; undefined when the daemon reports no base. */
export function baseLineOf({ baseVersion, baseRead }: Pick<ManagerView, 'baseVersion' | 'baseRead'>): string | undefined {
  if (baseVersion === undefined) return undefined;
  const hasReadCurrentBase = baseRead !== undefined && baseRead.version >= baseVersion;
  if (!hasReadCurrentBase) return `Base v${baseVersion}, non lue`;
  return `Base v${baseRead.version}, lue le ${READ_DAY_FORMAT.format(new Date(baseRead.readAt))}`;
}
