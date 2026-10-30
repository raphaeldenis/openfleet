import { ARBITER_ROLE, isLegacyMission, type ManagerView, type Session } from '@openfleet/shared';
import { isPulseEnabled, modeOf, type ManagerRecord } from './managerRepository.js';
import { nextPulseAt } from './pulseTiming.js';

export interface DeniedCommandCounts {
  deniedCommandCount: number;
  deniedCommandTotal: number;
  /** The note_not_read warnings the manager received over the last NOTE_NOT_READ_WARNING_WINDOW_HOURS. */
  noteNotReadWarningCount: number;
}

export const NO_DENIED_COMMANDS: DeniedCommandCounts = { deniedCommandCount: 0, deniedCommandTotal: 0, noteNotReadWarningCount: 0 };

/** A child counts against the children cap of its manager while it is live or waiting for the daemon to restart it; the arbiter the daemon spawns and a child whose launch failed never count. */
export const countsAgainstChildrenCap = (child: Pick<Session, 'role' | 'state' | 'restartPending' | 'readiness'>): boolean => {
  const isArbiter = child.role === ARBITER_ROLE;
  const isActive = child.state !== 'closed' || child.restartPending === true;
  const hasFailedToLaunch = child.readiness === 'failed';
  return isActive && !isArbiter && !hasFailedToLaunch;
};

export interface ManagerBaseIdentity {
  version: number;
  sha: string;
}

export function toManagerView(record: ManagerRecord, childrenCount: number, deniedCommands: DeniedCommandCounts = NO_DENIED_COMMANDS, currentBase?: ManagerBaseIdentity): ManagerView {
  return {
    expertise: record.expertise ?? '',
    pulseActions: record.pulseActions ?? [],
    profileRev: record.profileRev ?? 1,
    sessionId: record.sessionId,
    pulseSeconds: record.pulseSeconds,
    pulseEnabled: isPulseEnabled(record),
    mode: modeOf(record),
    sleepHandoffPending: record.sleepHandoffPending === true,
    ...(record.modeChangedAt && { modeChangedAt: record.modeChangedAt }),
    ...(record.sleepHandoffDeliveredAt && { sleepHandoffDeliveredAt: record.sleepHandoffDeliveredAt }),
    childAutoRestart: record.childAutoRestart === true,
    childrenCap: record.childrenCap,
    missionText: record.missionText,
    legacyMission: isLegacyMission(record.missionText),
    lastPulseAt: record.lastPulseAt,
    nextPulseAt: nextPulseAt(record),
    childrenCount,
    childrenHeadroom: Math.max(0, record.childrenCap - childrenCount),
    missionNoteId: record.missionNoteId,
    pinMissionNote: record.pinMissionNote === true,
    logStoreId: record.logStoreId,
    ...(currentBase && { baseVersion: currentBase.version }),
    ...(record.baseRead && { baseRead: record.baseRead }),
    ...deniedCommands,
  };
}
