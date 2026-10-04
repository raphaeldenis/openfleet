import { describe, expect, it, vi } from 'vitest';
import { DocsFolderSupervisor } from './docsFolderSupervisor.js';
import type { ProjectRecord } from './projectRepository.js';

const aProject = (id: string, docsFolderPath: string | null): ProjectRecord => ({ id, name: id, docsFolderPath, createdAt: 't0' });

function setup(projectRecords: ProjectRecord[]) {
  const calls: string[] = [];
  const unwatchers = new Map<string, ReturnType<typeof vi.fn>>();
  const docs = {
    reconcileOnBoot: vi.fn((projectId: string) => {
      calls.push(`reconcile:${projectId}`);
      return { applied: [], oversized: [], missing: [], unreadable: [], escaped: [] };
    }),
    attachFolder: vi.fn((projectId: string) => { calls.push(`attach:${projectId}`); return []; }),
    watch: vi.fn((projectId: string) => {
      calls.push(`watch:${projectId}`);
      const unwatch = vi.fn();
      unwatchers.set(projectId, unwatch);
      return unwatch;
    }),
  };
  const projects = { list: () => projectRecords, get: (id: string) => projectRecords.find((project) => project.id === id) };
  const onError = vi.fn();
  const supervisor = new DocsFolderSupervisor({ projects, docs, onError });
  return { supervisor, docs, calls, unwatchers, onError };
}

describe('DocsFolderSupervisor start', () => {
  it('watches, reconciles and imports each project that has a docs folder, and skips the others', () => {
    const { supervisor, calls } = setup([aProject('p1', '/docs/one'), aProject('p2', null), aProject('p3', '/docs/three')]);

    supervisor.start();

    expect(calls).toEqual(['watch:p1', 'reconcile:p1', 'attach:p1', 'watch:p3', 'reconcile:p3', 'attach:p3']);
  });

  it('watches before it imports, so an edit during the import is not lost', () => {
    const { supervisor, docs } = setup([aProject('p1', '/docs/one')]);
    let isWatchingWhenImportRuns = false;
    docs.attachFolder.mockImplementation(() => {
      isWatchingWhenImportRuns = docs.watch.mock.calls.length > 0;
      return [];
    });

    supervisor.start();

    expect(isWatchingWhenImportRuns).toBe(true);
  });

  it('imports from the folder the project stores', () => {
    const { supervisor, docs } = setup([aProject('p1', '/docs/one')]);

    supervisor.start();

    expect(docs.attachFolder).toHaveBeenCalledExactlyOnceWith('p1', '/docs/one');
  });

  it('does nothing when no project has a docs folder', () => {
    const { supervisor, calls } = setup([aProject('p1', null)]);

    supervisor.start();

    expect(calls).toEqual([]);
  });

  it('reports a failing step, carries on with the other steps and the other projects, and never throws', () => {
    const { supervisor, docs, calls, onError } = setup([aProject('p1', '/docs/one'), aProject('p2', '/docs/two')]);
    const folderGone = new Error('ENOENT');
    docs.reconcileOnBoot.mockImplementationOnce(() => { throw folderGone; });
    docs.watch.mockImplementationOnce(() => { throw folderGone; });

    expect(() => supervisor.start()).not.toThrow();

    expect(onError).toHaveBeenCalledWith({ projectId: 'p1', step: 'reconcile', error: folderGone });
    expect(onError).toHaveBeenCalledWith({ projectId: 'p1', step: 'watch', error: folderGone });
    expect(calls).toContain('attach:p1');
    expect(calls).toEqual(expect.arrayContaining(['reconcile:p2', 'attach:p2', 'watch:p2']));
  });
});

describe('DocsFolderSupervisor watchProject', () => {
  it('starts watching a project that has just got a folder', () => {
    const records = [aProject('p1', null)];
    const { supervisor, calls } = setup(records);
    supervisor.start();
    records[0] = aProject('p1', '/docs/one');

    supervisor.watchProject('p1');

    expect(calls).toEqual(['watch:p1', 'reconcile:p1', 'attach:p1']);
  });

  it('stops the previous watcher of a project before it watches again', () => {
    const { supervisor, unwatchers } = setup([aProject('p1', '/docs/one')]);
    supervisor.start();
    const firstUnwatch = unwatchers.get('p1')!;

    supervisor.watchProject('p1');

    expect(firstUnwatch).toHaveBeenCalledOnce();
    expect(unwatchers.get('p1')).not.toBe(firstUnwatch);
  });

  it('ignores an unknown project and a project without a folder', () => {
    const { supervisor, calls } = setup([aProject('p1', null)]);

    supervisor.watchProject('p1');
    supervisor.watchProject('missing');

    expect(calls).toEqual([]);
  });
});

describe('DocsFolderSupervisor stop', () => {
  it('stops every watcher once and refuses to watch afterwards', () => {
    const { supervisor, unwatchers, calls } = setup([aProject('p1', '/docs/one'), aProject('p2', '/docs/two')]);
    supervisor.start();

    supervisor.stop();
    supervisor.stop();
    supervisor.watchProject('p1');

    expect(unwatchers.get('p1')).toHaveBeenCalledOnce();
    expect(unwatchers.get('p2')).toHaveBeenCalledOnce();
    expect(calls.filter((call) => call.startsWith('watch:'))).toHaveLength(2);
  });

  it('keeps stopping the other watchers when one unsubscribe throws', () => {
    const { supervisor, unwatchers, onError } = setup([aProject('p1', '/docs/one'), aProject('p2', '/docs/two')]);
    supervisor.start();
    const failure = new Error('close failed');
    unwatchers.get('p1')!.mockImplementation(() => { throw failure; });

    expect(() => supervisor.stop()).not.toThrow();

    expect(unwatchers.get('p2')).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith({ projectId: 'p1', step: 'unwatch', error: failure });
  });
});
