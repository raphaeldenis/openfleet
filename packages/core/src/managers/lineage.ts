import type { Session } from '@openfleet/shared';

type LineageNode = Pick<Session, 'id' | 'parentId'>;

/** The id of the topmost ancestor of `session` (itself when it has no parent); a parent that no longer exists ends the climb at its id, and a parent already climbed through (a cycle) ends it at the last session before the cycle closes. */
export function lineageRootIdOf(sessions: { get(id: string): LineageNode | undefined }, session: LineageNode): string {
  const climbed = new Set<string>([session.id]);
  let root = session;
  while (root.parentId !== undefined) {
    const parent = sessions.get(root.parentId);
    if (parent === undefined) return root.parentId;
    const closesACycle = climbed.has(parent.id);
    if (closesACycle) return root.id;
    climbed.add(parent.id);
    root = parent;
  }
  return root.id;
}

/** The ids of every session beneath `ancestorId`, children first then their own descendants; the ancestor itself is not part of it. */
export function descendantSessionIdsOf(sessions: Pick<Session, 'id' | 'parentId'>[], ancestorId: string): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const { id, parentId } of sessions) {
    if (parentId === undefined) continue;
    childrenByParent.set(parentId, [...(childrenByParent.get(parentId) ?? []), id]);
  }
  const descendants: string[] = [];
  const toVisit = [ancestorId];
  const visited = new Set<string>([ancestorId]);
  for (let parentId = toVisit.shift(); parentId !== undefined; parentId = toVisit.shift()) {
    for (const childId of childrenByParent.get(parentId) ?? []) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      descendants.push(childId);
      toVisit.push(childId);
    }
  }
  return descendants;
}
