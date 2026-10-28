import { isLegacyMission, type ManagerView } from '@openfleet/shared';
import { isPulseEnabled, type ManagerRecord } from './managerRepository.js';
import { nextPulseAt } from './pulseTiming.js';

export interface DeniedCommandCounts {
  deniedCommandCount: number;
  deniedCommandTotal: number;
  /** The note_not_read warnings the manager received over the last NOTE_NOT_READ_WARNING_WINDOW_HOURS. */
  noteNotReadWarningCount: number;
}

export const NO_DENIED_COMMANDS: DeniedCommandCounts = { deniedCommandCount: 0, deniedCommandTotal: 0, noteNotReadWarningCount: 0 };

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
