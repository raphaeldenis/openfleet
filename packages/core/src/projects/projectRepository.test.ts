import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { ProjectRepository } from './projectRepository.js';

describe('ProjectRepository', () => {
  it('inserts and reads back a project', () => {
    const repository = new ProjectRepository(openDatabase(':memory:'));

    repository.insert({ id: 'p1', name: 'OpenFleet', docsFolderPath: '/docs/openfleet', createdAt: 't0' });

    expect(repository.get('p1')).toEqual({ id: 'p1', name: 'OpenFleet', docsFolderPath: '/docs/openfleet', createdAt: 't0' });
  });

  it('reads a project without a docs folder as docsFolderPath null', () => {
    const repository = new ProjectRepository(openDatabase(':memory:'));

    repository.insert({ id: 'p1', name: 'OpenFleet', docsFolderPath: null, createdAt: 't0' });

    expect(repository.get('p1')!.docsFolderPath).toBeNull();
  });

  it('returns undefined for an unknown project', () => {
    const repository = new ProjectRepository(openDatabase(':memory:'));

    expect(repository.get('nope')).toBeUndefined();
  });

  it('lists every project in creation order', () => {
    const repository = new ProjectRepository(openDatabase(':memory:'));
    repository.insert({ id: 'p2', name: 'Second', docsFolderPath: null, createdAt: 't2' });
    repository.insert({ id: 'p1', name: 'First', docsFolderPath: null, createdAt: 't1' });

    expect(repository.list().map((project) => project.id)).toEqual(['p1', 'p2']);
  });

  it('updates only the fields it is given', () => {
    const repository = new ProjectRepository(openDatabase(':memory:'));
    repository.insert({ id: 'p1', name: 'OpenFleet', docsFolderPath: '/docs/a', createdAt: 't0' });

    repository.update('p1', { name: 'Renamed' });
    repository.update('p1', { docsFolderPath: '/docs/b' });

    expect(repository.get('p1')).toEqual({ id: 'p1', name: 'Renamed', docsFolderPath: '/docs/b', createdAt: 't0' });
  });

  it('deletes a project', () => {
    const repository = new ProjectRepository(openDatabase(':memory:'));
    repository.insert({ id: 'p1', name: 'OpenFleet', docsFolderPath: null, createdAt: 't0' });

    repository.delete('p1');

    expect(repository.get('p1')).toBeUndefined();
  });

  it('indexes sessions by project', () => {
    const db = openDatabase(':memory:');

    const queryPlan = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM sessions WHERE project_id = 'p1'`).all() as { detail: string }[];

    expect(queryPlan.map((step) => step.detail).join(' ')).toContain('sessions_project');
  });
});
