import * as z from 'zod';
import { ModelIdSchema } from './models.js';

export const MANAGER_ROLE = 'manager';

const ONE_DAY_SECONDS = 86400;
export const MAX_CHILDREN_CAP = 64;
export const MAX_MISSION_BYTES = 64 * 1024;
/** The size a mission written today may have, in UTF-8 bytes: the project delta on top of the manager base. */
export const MAX_MISSION_DELTA_BYTES = 8192;

const missionBytesOf = (mission: string): number => new TextEncoder().encode(mission).length;

/** Whether a mission of this size is a legacy one: bigger than a delta, stored before the limit existed. */
export const isLegacyMission = (mission: string): boolean => missionBytesOf(mission) > MAX_MISSION_DELTA_BYTES;

/** Whether a mission may be written: it fits the delta, or it is no bigger than the mission it replaces (a legacy mission shrinks, never grows). */
export const isMissionWritable = ({ mission, storedMission }: { mission: string; storedMission?: string }): boolean => {
  const missionBytes = missionBytesOf(mission);
  const fitsTheDelta = missionBytes <= MAX_MISSION_DELTA_BYTES;
  const isNoBiggerThanStored = storedMission !== undefined && missionBytes <= missionBytesOf(storedMission);
  return fitsTheDelta || isNoBiggerThanStored;
};

const managerFieldsWithMissionUpTo = (maxMissionBytes: number) => ({
  pulseSeconds: z.number().int().min(1).max(ONE_DAY_SECONDS).optional(),
  childrenCap: z.number().int().min(1).max(MAX_CHILDREN_CAP),
  mission: z.string().min(1).refine((mission) => missionBytesOf(mission) <= maxMissionBytes, { message: `mission must be at most ${maxMissionBytes} bytes` }),
});

/** What a stored manager row must satisfy to be listed and pulsed: a legacy mission up to 64 KiB stays within the bounds. */
export const ManagerRecordBoundsSchema = z.object(managerFieldsWithMissionUpTo(MAX_MISSION_BYTES));

/** What a manager write carries: the 64 KiB is the transport envelope; the delta limit and the shrink rule are applied by the manager service against the stored mission. */
export const ManagerSpecSchema = z.object(managerFieldsWithMissionUpTo(MAX_MISSION_BYTES));
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

/** One whole read of the manager base: which version and sha the manager read, and when. */
export interface ManagerBaseRead {
  version: number;
  sha: string;
  readAt: string;
}

export interface ManagerView {
  sessionId: string;
  pulseSeconds: number;
  /** False while the manager is paused: it receives no pulse until it is resumed. */
  pulseEnabled: boolean;
  childrenCap: number;
  missionText: string;
  /** True while the mission is above the delta limit: it may shrink, never grow. Absent from an older daemon. */
  legacyMission?: boolean;
  lastPulseAt?: string;
  nextPulseAt: string;
  childrenCount: number;
  /** The places left under the cap: the cap minus the live children, never negative. */
  childrenHeadroom?: number;
  /** The note holding the manager's mission, when one is linked. */
  missionNoteId?: string;
  pinMissionNote?: boolean;
  /** The version of the manager base this daemon ships. */
  baseVersion?: number;
  /** The whole manager base the manager last read; absent while it never read it. */
  baseRead?: ManagerBaseRead;
  /** The table the manager logs its actions in, when one is bound. */
  logStoreId?: string;
  /** Refusals of commands in the manager's lineage that it has not looked at since its last read of `list_denied_commands`. */
  deniedCommandCount?: number;
  /** All the refusals recorded in the manager's lineage. */
  deniedCommandTotal?: number;
}
