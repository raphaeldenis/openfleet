import { Injectable, signal } from '@angular/core';

export type ApprovedKind = 'law' | 'permission';

export interface ApprovedText {
  readonly proposalId: string;
  readonly managerName: string;
  readonly kind: ApprovedKind;
  readonly typeLabel: string;
  readonly excerpt: string;
  readonly text: string;
  readonly noteQuery: { projectId: string | undefined; noteId: string } | undefined;
}

const STORAGE_KEY = 'openfleet.governance.approved-texts.v1';
const STORAGE_VERSION = 1;
const MAX_REMEMBERED_TEXTS = 20;
const APPROVED_TEXT_KEYS = ['proposalId', 'managerName', 'kind', 'typeLabel', 'excerpt', 'text', 'noteQuery'];
const NOTE_QUERY_KEYS = ['projectId', 'noteId'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactlyKeys = (record: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));

function parseNoteQuery(value: unknown): { ok: true; query: ApprovedText['noteQuery'] } | { ok: false } {
  if (value === null) return { ok: true, query: undefined };
  if (!isRecord(value) || !hasExactlyKeys(value, NOTE_QUERY_KEYS)) return { ok: false };
  const { projectId, noteId } = value;
  const isProjectIdValid = projectId === null || typeof projectId === 'string';
  if (!isProjectIdValid || typeof noteId !== 'string') return { ok: false };
  return { ok: true, query: { projectId: typeof projectId === 'string' ? projectId : undefined, noteId } };
}

function parseApprovedText(value: unknown): ApprovedText | undefined {
  if (!isRecord(value) || !hasExactlyKeys(value, APPROVED_TEXT_KEYS)) return undefined;
  const { proposalId, managerName, kind, typeLabel, excerpt, text } = value;
  const areAllTextsStrings = [proposalId, managerName, typeLabel, excerpt, text].every((field) => typeof field === 'string');
  const isKindKnown = kind === 'law' || kind === 'permission';
  const noteQuery = parseNoteQuery(value['noteQuery']);
  if (!areAllTextsStrings || !isKindKnown || !noteQuery.ok) return undefined;
  return { proposalId, managerName, kind, typeLabel, excerpt, text, noteQuery: noteQuery.query } as ApprovedText;
}

function readStoredTexts(): readonly ApprovedText[] {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!isRecord(stored) || stored['version'] !== STORAGE_VERSION || !Array.isArray(stored['items'])) return [];
    const items = stored['items'].map(parseApprovedText);
    const isEveryItemValid = items.every((item) => item !== undefined);
    return isEveryItemValid ? (items as ApprovedText[]).slice(-MAX_REMEMBERED_TEXTS) : [];
  } catch {
    return [];
  }
}

function writeStoredTexts(texts: readonly ApprovedText[]): void {
  try {
    const items = texts.map((approved) => ({ ...approved, noteQuery: approved.noteQuery ? { projectId: approved.noteQuery.projectId ?? null, noteId: approved.noteQuery.noteId } : null }));
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, items }));
  } catch {
    // The page works without storage: the texts then live until the page is reloaded.
  }
}

/** The approved texts the human still has to copy into the mission note: they outlive the Inbox filter, the Inbox itself and a page reload until dismissed. */
@Injectable({ providedIn: 'root' })
export class GovernanceApprovedTexts {
  private readonly remembered = signal<readonly ApprovedText[]>(readStoredTexts());
  readonly texts = this.remembered.asReadonly();

  remember(approved: ApprovedText): void {
    this.replaceAll([...this.remembered().filter((candidate) => candidate.proposalId !== approved.proposalId), approved].slice(-MAX_REMEMBERED_TEXTS));
  }

  dismiss(proposalId: string): void {
    this.replaceAll(this.remembered().filter((approved) => approved.proposalId !== proposalId));
  }

  private replaceAll(texts: readonly ApprovedText[]): void {
    this.remembered.set(texts);
    writeStoredTexts(texts);
  }
}
