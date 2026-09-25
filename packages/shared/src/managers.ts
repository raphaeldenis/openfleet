import { z } from 'zod';

export const MANAGER_ROLE = 'manager';

const ONE_DAY_SECONDS = 86400;
const MAX_CHILDREN_CAP = 64;
const MAX_MISSION_BYTES = 64 * 1024;

export const ManagerSpecSchema = z.object({
  pulseSeconds: z.number().int().min(1).max(ONE_DAY_SECONDS),
  childrenCap: z.number().int().min(1).max(MAX_CHILDREN_CAP),
  mission: z.string().min(1).refine((mission) => new TextEncoder().encode(mission).length <= MAX_MISSION_BYTES, { message: `mission must be at most ${MAX_MISSION_BYTES} bytes` }),
});
export type ManagerSpec = z.infer<typeof ManagerSpecSchema>;

export interface ManagerView {
  sessionId: string;
  pulseSeconds: number;
  childrenCap: number;
  missionText: string;
  lastPulseAt?: string;
  nextPulseAt: string;
  childrenCount: number;
}
