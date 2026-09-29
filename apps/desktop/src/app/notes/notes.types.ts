import type { NoteFolder } from '@openfleet/shared';

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

export interface NoteVersionSummary {
  id: string;
  rev: number;
  author: string;
  createdAt: string;
}
