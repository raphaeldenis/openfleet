import { MANAGER_ROLE, type Session } from '@openfleet/shared';

export const SHOW_CLOSED_STORAGE_KEY = 'openfleet.sidebar.showClosed';
const SHOW_CLOSED_ON = '1';
const NO_PROJECT_LABEL = 'No project';
const UNKNOWN_PROJECT_LABEL = 'Unknown project';

export interface ClosedVisibility { readonly showClosed: boolean }

export interface SessionGroup {
  readonly projectId: string | null;
  readonly label: string | null;
  readonly sessions: Session[];
}

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const isClosed = (session: Session) => session.state === 'closed';
const isManager = (session: Session) => session.role === MANAGER_ROLE;
const isClosedManager = (session: Session) => isManager(session) && isClosed(session);

function listedSessionsOf(sessions: readonly Session[]): Session[] {
  return sessions.filter((session) => !isClosedManager(session));
}

function hasLiveDescendant(sessions: readonly Session[], session: Session): boolean {
  return sessions.some((candidate) => candidate.parentId === session.id && (!isClosed(candidate) || hasLiveDescendant(sessions, candidate)));
}

function isVisible(sessions: readonly Session[], session: Session, { showClosed }: ClosedVisibility): boolean {
  return showClosed || !isClosed(session) || hasLiveDescendant(sessions, session);
}

/** Returns the parentless sessions the list shows; closed managers never appear and closed sessions appear only on request or while a descendant is live. */
export function rootsOfSessionList(sessions: readonly Session[], visibility: ClosedVisibility): Session[] {
  const listed = listedSessionsOf(sessions);
  const listedIds = new Set(listed.map((session) => session.id));
  const isRoot = (session: Session) => !session.parentId || !listedIds.has(session.parentId);
  return listed.filter((session) => isRoot(session) && isVisible(listed, session, visibility));
}

/** Returns the children of a listed session that the list shows. */
export function childrenOfInList(sessions: readonly Session[], parentId: string, visibility: ClosedVisibility): Session[] {
  const listed = listedSessionsOf(sessions);
  return listed.filter((session) => session.parentId === parentId && isVisible(listed, session, visibility));
}

/** Returns how many closed sessions the "Show closed" toggle reveals; closed managers are not counted because they live in the Managers group. */
export function closedSessionCountOf(sessions: readonly Session[]): number {
  return listedSessionsOf(sessions).filter(isClosed).length;
}

/** Groups roots by project, projects by name, "No project" last; returns one headerless group when no root has a project. */
export function groupByProject(roots: readonly Session[], projectNames: ReadonlyMap<string, string>): SessionGroup[] {
  const hasAnyProject = roots.some((session) => session.projectId);
  if (!hasAnyProject) return [{ projectId: null, label: null, sessions: [...roots] }];

  const rootsByProject = new Map<string | null, Session[]>();
  for (const root of roots) {
    const projectId = root.projectId ?? null;
    rootsByProject.set(projectId, [...(rootsByProject.get(projectId) ?? []), root]);
  }
  const labelOf = (projectId: string) => projectNames.get(projectId) ?? UNKNOWN_PROJECT_LABEL;
  const projectGroups = [...rootsByProject.entries()]
    .filter((entry): entry is [string, Session[]] => entry[0] !== null)
    .map(([projectId, sessions]) => ({ projectId, label: labelOf(projectId), sessions }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const withoutProject = rootsByProject.get(null);
  const noProjectGroup = withoutProject ? [{ projectId: null, label: NO_PROJECT_LABEL, sessions: withoutProject }] : [];
  return [...projectGroups, ...noProjectGroup];
}

type StorageSource = () => PreferenceStorage;

const browserStorage: StorageSource = () => localStorage;

export function readShowClosedPreference(storageOf: StorageSource = browserStorage): boolean {
  try {
    return storageOf().getItem(SHOW_CLOSED_STORAGE_KEY) === SHOW_CLOSED_ON;
  } catch {
    return false;
  }
}

export function writeShowClosedPreference(showClosed: boolean, storageOf: StorageSource = browserStorage): void {
  try {
    storageOf().setItem(SHOW_CLOSED_STORAGE_KEY, showClosed ? SHOW_CLOSED_ON : '0');
  } catch {
    // The preference is a convenience; an unavailable storage only loses persistence.
  }
}
