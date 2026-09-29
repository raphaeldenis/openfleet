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

export interface NewNote {
  projectId: string;
  title: string;
  bodyMd: string;
  folder?: NoteFolder;
  shared?: boolean;
}

export interface NoteChange {
  expectedRev: number;
  bodyMd?: string;
  title?: string;
}

export interface NoteRestore {
  rev: number;
  expectedRev?: number;
}

export interface NoteSearchResult extends NoteSummary {
  snippet: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Project {
  id: string;
  name: string;
  docsFolderPath: string | null;
}

export interface NoteVersionSummary {
  id: string;
  rev: number;
  author: string;
  createdAt: string;
}
