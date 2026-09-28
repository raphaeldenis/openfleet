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

export const MENTION_KINDS = ['note', 'repo', 'table', 'playbook'] as const;
export const MentionKindSchema = z.enum(MENTION_KINDS);
export type MentionKind = z.infer<typeof MentionKindSchema>;

const MENTION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export const MentionRefSchema = z.object({
  kind: MentionKindSchema,
  id: z.string().regex(MENTION_ID_PATTERN),
});
export type MentionRef = z.infer<typeof MentionRefSchema>;
