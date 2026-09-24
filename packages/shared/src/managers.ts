import { z } from 'zod';

export const MANAGER_ROLE = 'manager';

export const ManagerSpecSchema = z.object({
  pulseSeconds: z.number().int().positive(),
  childrenCap: z.number().int().positive(),
  mission: z.string().min(1),
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
