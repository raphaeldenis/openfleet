import type { ManagerView } from '@openfleet/shared';
import type { ManagerRecord } from './managerRepository.js';
import { nextPulseAt } from './pulseTiming.js';

export function toManagerView(record: ManagerRecord, childrenCount: number): ManagerView {
  return {
    sessionId: record.sessionId,
    pulseSeconds: record.pulseSeconds,
    childrenCap: record.childrenCap,
    missionText: record.missionText,
    lastPulseAt: record.lastPulseAt,
    nextPulseAt: nextPulseAt(record),
    childrenCount,
  };
}
