import type { ManagerView } from '@openfleet/shared';
import { isPulseEnabled, type ManagerRecord } from './managerRepository.js';
import { nextPulseAt } from './pulseTiming.js';

export interface DeniedCommandCounts {
  deniedCommandCount: number;
  deniedCommandTotal: number;
}

export const NO_DENIED_COMMANDS: DeniedCommandCounts = { deniedCommandCount: 0, deniedCommandTotal: 0 };

export function toManagerView(record: ManagerRecord, childrenCount: number, deniedCommands: DeniedCommandCounts = NO_DENIED_COMMANDS): ManagerView {
  return {
    sessionId: record.sessionId,
    pulseSeconds: record.pulseSeconds,
    pulseEnabled: isPulseEnabled(record),
    childrenCap: record.childrenCap,
    missionText: record.missionText,
    lastPulseAt: record.lastPulseAt,
    nextPulseAt: nextPulseAt(record),
    childrenCount,
    missionNoteId: record.missionNoteId,
    pinMissionNote: record.pinMissionNote === true,
    logStoreId: record.logStoreId,
    ...deniedCommands,
  };
}
