import type { Session } from '@openfleet/shared';

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
