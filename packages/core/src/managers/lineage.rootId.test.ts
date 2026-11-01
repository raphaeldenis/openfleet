import type { Session } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { lineageRootIdOf } from './lineage.js';

type Node = Pick<Session, 'id' | 'parentId'>;

const registryOf = (...nodes: Node[]) => ({ get: (id: string) => nodes.find((node) => node.id === id) });

describe('the root of a lineage', () => {
  it('is the session itself when it has no parent', () => {
    const lead: Node = { id: 'lead' };

    expect(lineageRootIdOf(registryOf(lead), lead)).toBe('lead');
  });

  it('is the topmost ancestor of a grandchild', () => {
    const lead: Node = { id: 'lead' };
    const child: Node = { id: 'child', parentId: 'lead' };
    const grandchild: Node = { id: 'grandchild', parentId: 'child' };

    expect(lineageRootIdOf(registryOf(lead, child, grandchild), grandchild)).toBe('lead');
  });

  it('is the last known ancestor when a parent no longer exists', () => {
    const orphan: Node = { id: 'orphan', parentId: 'gone' };

    expect(lineageRootIdOf(registryOf(orphan), orphan)).toBe('gone');
  });

  it('is the topmost ancestor however deep the lineage runs', () => {
    const DEPTH = 200;
    const chain: Node[] = Array.from({ length: DEPTH }, (_, level) => (level === 0 ? { id: 'node-0' } : { id: `node-${level}`, parentId: `node-${level - 1}` }));

    expect(lineageRootIdOf(registryOf(...chain), chain[DEPTH - 1]!)).toBe('node-0');
  });

  it('stops on a parent cycle instead of looping, and answers a member of the cycle', () => {
    const a: Node = { id: 'a', parentId: 'b' };
    const b: Node = { id: 'b', parentId: 'a' };

    expect(['a', 'b']).toContain(lineageRootIdOf(registryOf(a, b), a));
  });

  it('stops on a cycle that does not include the session it starts from', () => {
    const entry: Node = { id: 'entry', parentId: 'a' };
    const a: Node = { id: 'a', parentId: 'b' };
    const b: Node = { id: 'b', parentId: 'a' };

    expect(['a', 'b']).toContain(lineageRootIdOf(registryOf(entry, a, b), entry));
  });
});
