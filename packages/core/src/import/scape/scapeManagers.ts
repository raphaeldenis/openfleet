import { join } from 'node:path';
import { ManagerSpecSchema, ModelIdSchema, type HarnessId } from '@openfleet/shared';
import type { ScapeArgus } from './scapeArguses.js';
import { ScapeImportError } from './scapeImportError.js';
import { composeMission } from './scapeManagerMission.js';
import type { RecordValues } from './scapeTarget.js';
import { appleReferenceToIso } from './scapeTime.js';

const OPENFLEET_HARNESS_BY_SCAPE_HARNESS: Record<string, HarnessId> = { 'claude-code': 'claude-cli' };
const CLAUDE_MODEL_ID_WITH_FAMILY = /^claude-(opus|sonnet|haiku|fable)-/;
const SAFE_FOLDER_NAME_CHARACTERS = /[^A-Za-z0-9._-]+/g;
const DOT_RUN = /\.{2,}/g;
const LEADING_DOTS_AND_DASHES = /^[.-]+/;
const ID_PREFIX_LENGTH_IN_FOLDER_NAME = 8;

export interface PlannedManager {
  id: string;
  session: { name: string; directory: string; model: string | null; harness: HarnessId; projectId: string; createdAt: string };
  manager: { pulseSeconds: number; childrenCap: number; missionText: string };
  hasUnconvertedGrant: boolean;
}

export interface ManagersPlan {
  managers: PlannedManager[];
  /** Arguses left out because their mission note is not part of this import or their mission is unusable. */
  skippedCount: number;
}

const unreadable = (message: string, cause?: unknown) => new ScapeImportError({ code: 'SCAPE_SOURCE_UNREADABLE', message, cause });

/** An exact Claude model id becomes the alias of its family; anything else is kept. */
export function modelAliasOf(scapeModel: string | undefined): string | null {
  if (scapeModel === undefined || scapeModel === '') return null;
  const family = CLAUDE_MODEL_ID_WITH_FAMILY.exec(scapeModel)?.[1];
  const alias = family ?? scapeModel;
  const validation = ModelIdSchema.safeParse(alias);
  if (!validation.success) throw unreadable(`the model of a Scape manager is not a valid model id`, validation.error);
  return validation.data;
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

function folderNameOf(name: string): string {
  return name.replace(SAFE_FOLDER_NAME_CHARACTERS, '-').replace(DOT_RUN, '.').replace(LEADING_DOTS_AND_DASHES, '');
}

/** One folder per manager under the managers root; a name that is empty once made safe, or already taken (case-insensitively), takes the start of the Argus id. */
function folderNamesByArgusId(arguses: ScapeArgus[]): Map<string, string> {
  const taken = new Set<string>();
  const folderNames = new Map<string, string>();
  for (const argus of arguses) {
    const safeName = folderNameOf(argus.name);
    const idPrefix = argus.id.slice(0, ID_PREFIX_LENGTH_IN_FOLDER_NAME);
    const candidates = [safeName, `${safeName}-${idPrefix}`, idPrefix].filter((candidate) => candidate !== '' && !candidate.startsWith('-'));
    const folderName = candidates.find((candidate) => !taken.has(candidate.toLowerCase())) ?? argus.id;
    taken.add(folderName.toLowerCase());
    folderNames.set(argus.id, folderName);
  }
  return folderNames;
}

/** Plans one manager per Scape Argus whose mission note is part of the plan; the mission body is the markdown the note import writes. */
export function planManagers(input: { arguses: ScapeArgus[]; notes: { id: string; record: RecordValues }[]; managersRoot: string }): ManagersPlan {
  const noteRecordById = new Map(input.notes.map((note) => [note.id, note.record]));
  const folderNames = folderNamesByArgusId(input.arguses);
  const managers: PlannedManager[] = [];
  let skippedCount = 0;

  for (const argus of input.arguses) {
    const missionNote = noteRecordById.get(argus.noteId);
    const harness = harnessOf(argus);
    assertPulseAndCapWithinBounds(argus);
    const model = modelAliasOf(argus.model);
    if (missionNote === undefined) { skippedCount++; continue; }

    const mission = composeMission({ noteBody: String(missionNote.body_md), governanceRequests: argus.governanceRequests, resourceGrants: argus.resourceGrants });
    if (!isUsableMission(mission.text)) { skippedCount++; continue; }

    managers.push({
      id: argus.id,
      session: { name: argus.name, directory: join(input.managersRoot, folderNames.get(argus.id)!), model, harness, projectId: String(missionNote.project_id), createdAt: appleReferenceToIso(argus.createdAt) },
      manager: { pulseSeconds: argus.pulseInterval, childrenCap: argus.childrenCap, missionText: mission.text },
      hasUnconvertedGrant: mission.hasUnconvertedGrant,
    });
  }
  return { managers, skippedCount };
}
