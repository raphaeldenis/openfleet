import { join } from 'node:path';
import { ManagerSpecSchema, type HarnessId, type MentionKind } from '@openfleet/shared';
import type { ScapeArgus } from './scapeArguses.js';
import { ScapeImportError } from './scapeImportError.js';
import { composeMission, type MissionToolReferences, type ResourceAvailability } from './scapeManagerMission.js';
import type { RecordValues } from './scapeTarget.js';
import { appleReferenceToIso } from './scapeTime.js';

const OPENFLEET_HARNESS_BY_SCAPE_HARNESS: Record<string, HarnessId> = { 'claude-code': 'claude-cli' };
const MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable']);
const CLAUDE_MODEL_ID_WITH_FAMILY = /^claude-(opus|sonnet|haiku|fable)-/;
const SAFE_FOLDER_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const UNSAFE_FOLDER_NAME_CHARACTERS = /[^A-Za-z0-9._-]+/g;
const DOT_RUN = /\.{2,}/g;
const LEADING_DOTS_AND_DASHES = /^[.-]+/;
const MAX_FOLDER_NAME_LENGTH = 64;
const ID_PREFIX_LENGTH_IN_FOLDER_NAME = 8;

export interface PlannedManager {
  id: string;
  session: { name: string; directory: string; model: string | null; harness: HarnessId; projectId: string; createdAt: string };
  manager: { pulseSeconds: number; childrenCap: number; missionText: string };
  isNotFullyConverted: boolean;
  pendingPlaybookMentionCount: number;
  toolReferences: MissionToolReferences;
}

export interface ManagersPlan {
  managers: PlannedManager[];
  /** Arguses left out because their mission note is not part of this import or their mission is unusable. */
  skippedCount: number;
}

export interface AvailableResources { noteIds: Set<string>; tableIds: Set<string> }

const unreadable = (message: string, cause?: unknown) => new ScapeImportError({ code: 'SCAPE_SOURCE_UNREADABLE', message, cause });

/** An exact Claude model id becomes the alias of its family; a model that is no known alias is not stored and is reported. */
export function modelOf(scapeModel: string | undefined): { model: string | null; isRecognized: boolean } {
  const namesNoModel = scapeModel === undefined || scapeModel === '';
  if (namesNoModel) return { model: null, isRecognized: true };
  const alias = CLAUDE_MODEL_ID_WITH_FAMILY.exec(scapeModel)?.[1] ?? scapeModel;
  const isKnownAlias = MODEL_ALIASES.has(alias);
  return isKnownAlias ? { model: alias, isRecognized: true } : { model: null, isRecognized: false };
}

function harnessOf(argus: ScapeArgus): HarnessId {
  const harness = Object.hasOwn(OPENFLEET_HARNESS_BY_SCAPE_HARNESS, argus.harnessId) ? OPENFLEET_HARNESS_BY_SCAPE_HARNESS[argus.harnessId] : undefined;
  if (harness === undefined) throw unreadable(`the Scape manager ${argus.id} runs on the harness "${argus.harnessId}", which OpenFleet does not know`);
  return harness;
}

function assertPulseAndCapWithinBounds(argus: ScapeArgus): void {
  const validation = ManagerSpecSchema.omit({ mission: true }).safeParse({ pulseSeconds: argus.pulseInterval, childrenCap: argus.childrenCap });
  if (!validation.success) throw unreadable(`the pulse or the children cap of the Scape manager ${argus.id} is out of bounds`, validation.error);
}

const isUsableMission = (text: string) => ManagerSpecSchema.shape.mission.safeParse(text).success;

function safeFolderNameOf(name: string): string {
  return name.replace(UNSAFE_FOLDER_NAME_CHARACTERS, '-').replace(DOT_RUN, '.').replace(LEADING_DOTS_AND_DASHES, '').slice(0, MAX_FOLDER_NAME_LENGTH);
}

/** One safe, single-component folder per manager, unique case-insensitively: the name, else the name with the start of the id, else the id, else the id numbered. */
function folderNamesByArgusId(arguses: ScapeArgus[]): Map<string, string> {
  const taken = new Set<string>();
  const isFree = (candidate: string) => SAFE_FOLDER_NAME.test(candidate) && !taken.has(candidate.toLowerCase());
  const folderNames = new Map<string, string>();
  for (const argus of arguses) {
    const safeName = safeFolderNameOf(argus.name);
    const idPrefix = argus.id.slice(0, ID_PREFIX_LENGTH_IN_FOLDER_NAME);
    const candidates = [safeName, `${safeName}-${idPrefix}`, argus.id];
    const numberedIds = Array.from({ length: arguses.length + 1 }, (_, index) => `${argus.id}-${index + 2}`);
    const folderName = [...candidates, ...numberedIds].find(isFree)!;
    taken.add(folderName.toLowerCase());
    folderNames.set(argus.id, folderName);
  }
  return folderNames;
}

function availabilityFrom(available: AvailableResources) {
  return ({ kind, id }: { kind: MentionKind; id: string }): ResourceAvailability => {
    if (kind === 'playbook') return 'pending';
    const isAvailable = kind === 'note' ? available.noteIds.has(id) : kind === 'table' ? available.tableIds.has(id) : false;
    return isAvailable ? 'available' : 'missing';
  };
}

export interface PlanManagersInput {
  arguses: ScapeArgus[];
  notes: { id: string; record: RecordValues }[];
  availableResources: AvailableResources;
  managersRoot: string;
}

/** Plans one manager per Scape Argus whose mission note is part of the plan; the mission body is the markdown the note import writes. */
export function planManagers(input: PlanManagersInput): ManagersPlan {
  const noteRecordById = new Map(input.notes.map((note) => [note.id, note.record]));
  const folderNames = folderNamesByArgusId(input.arguses);
  const availabilityOf = availabilityFrom(input.availableResources);
  const managers: PlannedManager[] = [];
  let skippedCount = 0;

  for (const argus of input.arguses) {
    const missionNote = noteRecordById.get(argus.noteId);
    if (missionNote === undefined) { skippedCount++; continue; }

    const harness = harnessOf(argus);
    assertPulseAndCapWithinBounds(argus);
    const { model, isRecognized: isModelRecognized } = modelOf(argus.model);
    const mission = composeMission({ noteBody: String(missionNote.body_md), governanceRequests: argus.governanceRequests, resourceGrants: argus.resourceGrants, availabilityOf });
    if (!isUsableMission(mission.text)) { skippedCount++; continue; }

    managers.push({
      id: argus.id,
      session: { name: argus.name, directory: join(input.managersRoot, folderNames.get(argus.id)!), model, harness, projectId: String(missionNote.project_id), createdAt: appleReferenceToIso(argus.createdAt) },
      manager: { pulseSeconds: argus.pulseInterval, childrenCap: argus.childrenCap, missionText: mission.text },
      isNotFullyConverted: mission.hasUnconvertedGrant || !isModelRecognized,
      pendingPlaybookMentionCount: mission.pendingPlaybookMentionCount,
      toolReferences: mission.toolReferences,
    });
  }
  return { managers, skippedCount };
}
