import type { ManagerView } from '@openfleet/shared';
import { isPulseEnabled, type ManagerRecord } from './managerRepository.js';
import { nextPulseAt } from './pulseTiming.js';

export function toManagerView(record: ManagerRecord, childrenCount: number): ManagerView {
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
  };
}
