import type { Session } from '@openfleet/shared';

const MAX_LINEAGE_DEPTH = 32;

type LineageNode = Pick<Session, 'id' | 'parentId'>;

/** The id of the topmost ancestor of `session` (itself when it has no parent); a parent that no longer exists ends the climb at its id. */
export function lineageRootIdOf(sessions: { get(id: string): LineageNode | undefined }, session: LineageNode): string {
  let root = session;
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH && root.parentId !== undefined; depth += 1) {
    const parent = sessions.get(root.parentId);
    if (parent === undefined) return root.parentId;
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
