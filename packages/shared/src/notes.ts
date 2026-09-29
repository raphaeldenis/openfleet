import { z } from 'zod';

export const NOTE_FOLDERS = ['specs', 'plans', 'handoffs', 'reports'] as const;
export const NoteFolderSchema = z.enum(NOTE_FOLDERS);
export type NoteFolder = z.infer<typeof NoteFolderSchema>;

export interface Note {
  id: string;
  projectId: string;
  title: string;
  bodyMd: string;
  folder: NoteFolder | null;
  filePath: string | null;
  sourceHash: string | null;
  rev: number;
  shared: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NoteVersion {
  id: string;
  noteId: string;
  rev: number;
  bodyMd: string;
  author: string;
  changeSummary: string | null;
  createdAt: string;
}

export type NoteVersionSummary = Pick<NoteVersion, 'id' | 'rev' | 'author' | 'createdAt'>;

/** A note as the REST API lists it: never the body, the absolute file path or the content hash. */
export interface NoteSummary {
  id: string;
  title: string;
  folder: NoteFolder | null;
  rev: number;
  shared: boolean;
  fileBacked: boolean;
  updatedAt: string;
}

export interface NoteView extends NoteSummary {
  projectId: string;
  bodyMd: string;
  createdAt: string;
  docsRelativePath: string | null;
}

export interface NoteSearchResult extends NoteSummary {
  snippet: string;
}

export const MAX_NOTE_TITLE_CHARS = 512;
const TitleSchema = z.string().trim().min(1).max(MAX_NOTE_TITLE_CHARS);

export const CreateNoteRequestSchema = z.object({
  projectId: z.string().min(1),
  title: TitleSchema,
  bodyMd: z.string(),
  folder: NoteFolderSchema.optional(),
  shared: z.boolean().optional(),
});
export type CreateNoteRequest = z.infer<typeof CreateNoteRequestSchema>;

export const UpdateNoteRequestSchema = z.object({
  projectId: z.string().min(1),
  expectedRev: z.number().int(),
  title: TitleSchema.optional(),
  bodyMd: z.string().optional(),
}).refine((patch) => patch.title !== undefined || patch.bodyMd !== undefined, { message: 'title or bodyMd is required' });
export type UpdateNoteRequest = z.infer<typeof UpdateNoteRequestSchema>;

export const RestoreNoteRequestSchema = z.object({
  projectId: z.string().min(1),
  rev: z.number().int(),
  expectedRev: z.number().int(),
});
export type RestoreNoteRequest = z.infer<typeof RestoreNoteRequestSchema>;

export const MENTION_KINDS = ['note', 'repo', 'table', 'playbook'] as const;
export const MentionKindSchema = z.enum(MENTION_KINDS);
export type MentionKind = z.infer<typeof MentionKindSchema>;

const MENTION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export const MentionRefSchema = z.object({
  kind: MentionKindSchema,
  id: z.string().regex(MENTION_ID_PATTERN),
});
export type MentionRef = z.infer<typeof MentionRefSchema>;
