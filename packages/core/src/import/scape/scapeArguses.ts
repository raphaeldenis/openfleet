import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { ScapeImportError } from './scapeImportError.js';

export const ARGUSES_FILE_NAME = 'arguses.json';

/** An Argus id becomes a session id and may end up in a folder name: letters, digits, `_` and `-`, never starting with `-`. */
const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

const GovernanceRequestSchema = z.object({
  kind: z.string(),
  status: z.string(),
  text: z.string().default(''),
  scope: z.string().default(''),
  condition: z.string().default(''),
  exclusions: z.string().default(''),
  createdAt: z.number().default(0),
});

const ResourceGrantSchema = z.object({
  resourceType: z.string(),
  resourceId: z.string(),
  access: z.string(),
});

const ArgusSchema = z.object({
  id: z.string().regex(SAFE_ID),
  name: z.string().min(1),
  model: z.string().optional(),
  harnessId: z.string(),
  pulseInterval: z.number(),
  childrenCap: z.number(),
  noteId: z.string().min(1),
  createdAt: z.number(),
  governanceRequests: z.array(GovernanceRequestSchema).default([]),
  resourceGrants: z.array(ResourceGrantSchema).default([]),
});

const ArgusesFileSchema = z.object({ arguses: z.array(ArgusSchema) });

export type ScapeGovernanceRequest = z.infer<typeof GovernanceRequestSchema>;
export type ScapeResourceGrant = z.infer<typeof ResourceGrantSchema>;
export type ScapeArgus = z.infer<typeof ArgusSchema>;

const unreadable = (message: string, cause?: unknown) => new ScapeImportError({ code: 'SCAPE_SOURCE_UNREADABLE', message, cause });

function parseFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw unreadable(`${ARGUSES_FILE_NAME} cannot be read: ${(cause as Error).message}`, cause);
  }
}

/** Reads the Scape managers; a Scape home without `arguses.json` has none. Only the fields the import needs are kept: no resume id, transcript path or scratch folder. */
export function readArguses(scapeDir: string): ScapeArgus[] {
  const path = join(scapeDir, ARGUSES_FILE_NAME);
  if (!existsSync(path)) return [];
  const parsed = ArgusesFileSchema.safeParse(parseFile(path));
  if (!parsed.success) throw unreadable(`${ARGUSES_FILE_NAME} does not have the expected shape: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`, parsed.error);
  const ids = parsed.data.arguses.map((argus) => argus.id);
  const hasDuplicateId = new Set(ids).size !== ids.length;
  if (hasDuplicateId) throw unreadable(`${ARGUSES_FILE_NAME} lists the same Argus id twice`);
  return parsed.data.arguses;
}
