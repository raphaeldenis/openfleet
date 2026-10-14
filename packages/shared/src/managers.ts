import * as z from 'zod';
import { ModelIdSchema } from './models.js';

export const MANAGER_ROLE = 'manager';

const ONE_DAY_SECONDS = 86400;
export const MAX_CHILDREN_CAP = 64;
export const MAX_MISSION_BYTES = 64 * 1024;

export const ManagerSpecSchema = z.object({
  pulseSeconds: z.number().int().min(1).max(ONE_DAY_SECONDS).optional(),
  childrenCap: z.number().int().min(1).max(MAX_CHILDREN_CAP),
  mission: z.string().min(1).refine((mission) => new TextEncoder().encode(mission).length <= MAX_MISSION_BYTES, { message: `mission must be at most ${MAX_MISSION_BYTES} bytes` }),
});
export type ManagerSpec = z.infer<typeof ManagerSpecSchema>;

/** The fields of a manager that can be edited after it is created: at least one is given. The model belongs to its session; a null missionNoteId unlinks the mission note. */
export const UpdateManagerSchema = ManagerSpecSchema.partial().extend({
  model: ModelIdSchema.optional(),
  missionNoteId: z.string().min(1).nullable().optional(),
  pinMissionNote: z.boolean().optional(),
  pulseEnabled: z.boolean().optional(),
}).refine(
  (update) => Object.values(update).some((value) => value !== undefined),
  { message: 'pulseSeconds, childrenCap, mission, model, missionNoteId, pinMissionNote or pulseEnabled is required' },
);
export type UpdateManager = z.infer<typeof UpdateManagerSchema>;

/** Why a pulse reaches a manager, strongest first: a resume outranks a manual pulse, which outranks the interval. */
export const PULSE_WAKE_REASONS = ['resume', 'manual', 'interval'] as const;
export type PulseWakeReason = (typeof PULSE_WAKE_REASONS)[number];

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
  /** False while the manager is paused: it receives no pulse until it is resumed. */
  pulseEnabled: boolean;
  childrenCap: number;
  missionText: string;
  lastPulseAt?: string;
  nextPulseAt: string;
  childrenCount: number;
  /** The note holding the manager's mission, when one is linked. */
  missionNoteId?: string;
  pinMissionNote?: boolean;
  /** The table the manager logs its actions in, when one is bound. */
  logStoreId?: string;
  /** Refusals of commands in the manager's lineage that it has not looked at since its last read of `list_denied_commands`. */
  deniedCommandCount?: number;
  /** All the refusals recorded in the manager's lineage. */
  deniedCommandTotal?: number;
}
