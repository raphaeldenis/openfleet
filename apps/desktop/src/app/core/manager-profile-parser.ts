import type { ManagerBaseRead, ManagerProfile, ScapeImportStatus } from '@openfleet/shared';

const SCAPE_IMPORT_STATUSES: readonly ScapeImportStatus[] = ['not_imported', 'as_imported', 'edited_in_openfleet'];

const isText = (value: unknown): value is string => typeof value === 'string';
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Reads a manager profile from a daemon payload, keeping only its known fields; returns undefined when the payload is not one. */
export function parseManagerProfile(payload: unknown): ManagerProfile | undefined {
  const isObject = typeof payload === 'object' && payload !== null;
  if (!isObject) return undefined;
  const { manager, scapeImport } = payload as Record<string, unknown>;
  const isManagerObject = typeof manager === 'object' && manager !== null;
  if (!isManagerObject) return undefined;
  const { sessionId, pulseSeconds, childrenCap, missionText, lastPulseAt, nextPulseAt, childrenCount, missionNoteId, pinMissionNote, logStoreId, pulseEnabled } = manager as Record<string, unknown>;
  const hasManagerFields = isText(sessionId) && isCount(pulseSeconds) && isCount(childrenCap) && isText(missionText) && isText(nextPulseAt) && isCount(childrenCount);
  const hasKnownImportStatus = SCAPE_IMPORT_STATUSES.includes(scapeImport as ScapeImportStatus);
  if (!hasManagerFields || !hasKnownImportStatus) return undefined;
  const lastPulse = isText(lastPulseAt) ? { lastPulseAt } : {};
  const links = {
    ...(isText(missionNoteId) && { missionNoteId }),
    ...(typeof pinMissionNote === 'boolean' && { pinMissionNote }),
    ...(isText(logStoreId) && { logStoreId }),
  };
  const { baseVersion, baseRead } = manager as Record<string, unknown>;
  const base = { ...(isCount(baseVersion) && { baseVersion }), ...(isBaseRead(baseRead) && { baseRead: { version: baseRead.version, sha: baseRead.sha, readAt: baseRead.readAt } }) };
  return { manager: { sessionId, pulseSeconds, pulseEnabled: pulseEnabled !== false, childrenCap, missionText, nextPulseAt, childrenCount, ...lastPulse, ...links, ...base }, scapeImport: scapeImport as ScapeImportStatus };
}

function isBaseRead(value: unknown): value is ManagerBaseRead {
  if (typeof value !== 'object' || value === null) return false;
  const { version, sha, readAt } = value as Record<string, unknown>;
  return isCount(version) && isText(sha) && isText(readAt);
}
