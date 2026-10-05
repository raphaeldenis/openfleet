import * as z from 'zod';
import { ModelIdSchema } from './models.js';

export const MANAGER_ROLE = 'manager';

const ONE_DAY_SECONDS = 86400;
const MAX_CHILDREN_CAP = 64;
export const MAX_MISSION_BYTES = 64 * 1024;

export const ManagerSpecSchema = z.object({
  pulseSeconds: z.number().int().min(1).max(ONE_DAY_SECONDS).optional(),
  childrenCap: z.number().int().min(1).max(MAX_CHILDREN_CAP),
  mission: z.string().min(1).refine((mission) => new TextEncoder().encode(mission).length <= MAX_MISSION_BYTES, { message: `mission must be at most ${MAX_MISSION_BYTES} bytes` }),
});
export type ManagerSpec = z.infer<typeof ManagerSpecSchema>;

/** The fields of a manager that can be edited after it is created: at least one is given. The model belongs to its session. */
export const UpdateManagerSchema = ManagerSpecSchema.partial().extend({ model: ModelIdSchema.optional() }).refine(
  (update) => Object.values(update).some((value) => value !== undefined),
  { message: 'pulseSeconds, childrenCap, mission or model is required' },
);
export type UpdateManager = z.infer<typeof UpdateManagerSchema>;

export const REOPEN_MODES = ['resume', 'fresh'] as const;
export type ReopenMode = (typeof REOPEN_MODES)[number];
/** `resume` goes back into the stored conversation; `fresh` (managers only) starts a new one seeded with the mission. */
export const ReopenRequestSchema = z.object({ mode: z.enum(REOPEN_MODES).default('resume') });

/** Whether a manager came from a Scape import, and if so whether OpenFleet changed it since (a re-import then leaves it alone). */
export type ScapeImportStatus = 'not_imported' | 'as_imported' | 'edited_in_openfleet';

export interface ManagerProfile {
  manager: ManagerView;
  scapeImport: ScapeImportStatus;
}

export interface ManagerView {
  sessionId: string;
  pulseSeconds: number;
  childrenCap: number;
  missionText: string;
  lastPulseAt?: string;
  nextPulseAt: string;
  childrenCount: number;
}
