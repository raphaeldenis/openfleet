import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { maskedSecrets } from '../../redact.js';

export const MAX_INPUT_BYTES = 32 * 1024 * 1024;
export const MAX_SOURCE_ROWS = 50_000;
export const MAX_FACT_BYTES = 8 * 1024;
export const MAX_METADATA_BYTES = 1024;
export const MAX_ID_BYTES = 512;

export type KnowledgeRejectionReason = 'INVALID_ARGUMENTS' | 'INPUT_UNREADABLE' | 'SYMLINK_REFUSED' | 'INPUT_TOO_LARGE' | 'INVALID_EXPORT' | 'INVALID_MAPPING' | 'UNKNOWN_PROJECT' | 'REPOSITORY_UNAVAILABLE' | 'TARGET_UNAVAILABLE' | 'DAEMON_RUNNING' | 'CONFLICT' | 'FINAL_GATE_REQUIRED' | 'SEALED_SNAPSHOT_MISMATCH' | 'IMPORT_WRITE_FAILED' | 'REPORT_WRITE_FAILED';

export class KnowledgeImportError extends Error {
  constructor(readonly reason: KnowledgeRejectionReason) { super(reason); }
}

export function assertNoSymlink(path: string): void {
  if (!isAbsolute(path)) throw new KnowledgeImportError('INVALID_ARGUMENTS');
  for (let ancestor = path; ; ancestor = dirname(ancestor)) {
    try {
      if (lstatSync(ancestor).isSymbolicLink()) throw new KnowledgeImportError('SYMLINK_REFUSED');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (ancestor === dirname(ancestor)) return;
  }
}

export function readKnowledgeJson(path: string): unknown {
  let descriptor: number | undefined;
  try {
    assertNoSymlink(path);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = fstatSync(descriptor);
    if (!file.isFile()) throw new KnowledgeImportError('INPUT_UNREADABLE');
    if (file.size > MAX_INPUT_BYTES) throw new KnowledgeImportError('INPUT_TOO_LARGE');
    const bytes = Buffer.alloc(Math.min(file.size + 1, MAX_INPUT_BYTES + 1));
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const count = readSync(descriptor, bytes, bytesRead, bytes.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > file.size || bytesRead > MAX_INPUT_BYTES) throw new KnowledgeImportError('INPUT_TOO_LARGE');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof KnowledgeImportError) throw error;
    throw new KnowledgeImportError('INPUT_UNREADABLE');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export const isWellFormedUnicode = (value: string): boolean => !/[\uD800-\uDFFF]/u.test(value);
const boundedText = (maximumBytes: number) => z.string().refine((value) => {
  const fitsByteBound = Buffer.byteLength(value, 'utf8') <= maximumBytes;
  return isWellFormedUnicode(value) && fitsByteBound;
});
export const structuralId = boundedText(MAX_ID_BYTES).refine((value) => value.trim().length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value));
const freeText = boundedText(MAX_METADATA_BYTES);
const requiredText = (maximumBytes: number) => boundedText(maximumBytes).refine((value) => value.trim().length > 0);

function isUtcTimestamp(value: string): boolean {
  const hasUtcSyntax = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value);
  if (!hasUtcSyntax) return false;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  return date.toISOString().slice(0, 19) === value.slice(0, 19);
}

const utcTimestamp = z.string().refine(isUtcTimestamp).transform((value) => new Date(value).toISOString());
const exportRow = z.strictObject({
  id: structuralId,
  repo: structuralId,
  area: requiredText(MAX_METADATA_BYTES),
  fact: requiredText(MAX_FACT_BYTES),
  source_task: freeText.nullable(),
  source_kind: freeText.nullable(),
  verified_by: freeText.nullable(),
  created_at: utcTimestamp,
  retired_at: utcTimestamp.nullable(),
  retired_why: freeText.nullable(),
}).refine((row) => row.retired_at !== null || row.retired_why === null);

const sourceCount = z.number().int().min(0).max(MAX_SOURCE_ROWS);
const exportSchema = z.strictObject({
  version: z.literal(1),
  source: z.literal('scape_team.memory.knowledge'),
  snapshot_id: structuralId,
  exported_at: utcTimestamp,
  frozen_at: utcTimestamp.nullable(),
  freeze_verified: z.boolean(),
  repos: z.array(z.strictObject({ repo: structuralId, count: sourceCount, active_count: sourceCount, retired_count: sourceCount })).max(MAX_SOURCE_ROWS),
  rows: z.array(exportRow).max(MAX_SOURCE_ROWS),
});

export type KnowledgeExportRow = z.infer<typeof exportRow>;
export type KnowledgeExport = z.infer<typeof exportSchema>;

const maskedNullable = (value: string | null) => value === null ? null : maskedSecrets(value);

function maskedRow(row: KnowledgeExportRow): KnowledgeExportRow {
  return { ...row, area: maskedSecrets(row.area), fact: maskedSecrets(row.fact), source_task: maskedNullable(row.source_task), source_kind: maskedNullable(row.source_kind), verified_by: maskedNullable(row.verified_by), retired_why: maskedNullable(row.retired_why) };
}

function assertCompleteCounts(snapshot: KnowledgeExport): void {
  const repoCounts = new Map<string, { active: number; retired: number }>();
  const identities = new Set<string>();
  for (const row of snapshot.rows) {
    const identity = JSON.stringify([row.repo, row.id]);
    if (identities.has(identity)) throw new KnowledgeImportError('INVALID_EXPORT');
    identities.add(identity);
    const counts = repoCounts.get(row.repo) ?? { active: 0, retired: 0 };
    if (row.retired_at === null) counts.active += 1;
    else counts.retired += 1;
    repoCounts.set(row.repo, counts);
  }
  const manifestRepos = new Set<string>();
  for (const repo of snapshot.repos) {
    const counts = repoCounts.get(repo.repo) ?? { active: 0, retired: 0 };
    const countsMatch = repo.active_count === counts.active && repo.retired_count === counts.retired && repo.count === counts.active + counts.retired;
    if (manifestRepos.has(repo.repo) || !countsMatch) throw new KnowledgeImportError('INVALID_EXPORT');
    manifestRepos.add(repo.repo);
  }
  if ([...repoCounts.keys()].some((repo) => !manifestRepos.has(repo))) throw new KnowledgeImportError('INVALID_EXPORT');
}

export function parseKnowledgeExport(input: unknown): KnowledgeExport {
  const parsed = exportSchema.safeParse(input);
  if (!parsed.success) throw new KnowledgeImportError('INVALID_EXPORT');
  assertCompleteCounts(parsed.data);
  return { ...parsed.data, rows: parsed.data.rows.map(maskedRow) };
}
