import type { DocsFolderService } from '../notes/docsFolderService.js';
import type { ProjectRepository } from './projectRepository.js';

export type DocsFolderStep = 'reconcile' | 'import' | 'watch' | 'unwatch';

export interface DocsFolderFailure {
  projectId: string;
  step: DocsFolderStep;
  error: unknown;
}

export interface DocsFolderSupervisorDeps {
  projects: Pick<ProjectRepository, 'list' | 'get'>;
  docs: Pick<DocsFolderService, 'reconcileOnBoot' | 'attachFolder' | 'watch'>;
  /** Hears each step that failed; a failure never reaches the caller. */
  onError: (failure: DocsFolderFailure) => void;
}

/**
 * Keeps every project's docs folder in step with its notes: watches the folder for edits, reconciles the known notes,
 * then imports the files nobody knows yet. A step that fails (a deleted folder, a permission change) is reported and
 * never stops the next step or the next project.
 */
export class DocsFolderSupervisor {
  private readonly unwatchByProjectId = new Map<string, () => void>();
  private isStopped = false;

  constructor(private readonly deps: DocsFolderSupervisorDeps) {}

  start(): void {
    for (const { id } of this.deps.projects.list()) this.watchProject(id);
  }

  /** (Re)watches the project's docs folder first, so an edit made during the import is seen, then reconciles and imports it; a project without a folder is left alone. */
  watchProject(projectId: string): void {
    if (this.isStopped) return;
    const docsFolderPath = this.deps.projects.get(projectId)?.docsFolderPath;
    if (!docsFolderPath) return;

    this.stopWatching(projectId);
    const unwatch = this.attempt(projectId, 'watch', () => this.deps.docs.watch(projectId));
    if (unwatch) this.unwatchByProjectId.set(projectId, unwatch);
    this.attempt(projectId, 'reconcile', () => this.deps.docs.reconcileOnBoot(projectId));
    this.attempt(projectId, 'import', () => this.deps.docs.attachFolder(projectId, docsFolderPath));
  }

  stop(): void {
    this.isStopped = true;
    for (const projectId of [...this.unwatchByProjectId.keys()]) this.stopWatching(projectId);
  }

  private stopWatching(projectId: string): void {
    const unwatch = this.unwatchByProjectId.get(projectId);
    if (!unwatch) return;
    this.unwatchByProjectId.delete(projectId);
    this.attempt(projectId, 'unwatch', unwatch);
  }

  private attempt<T>(projectId: string, step: DocsFolderStep, run: () => T): T | undefined {
    try {
      return run();
    } catch (error) {
      this.deps.onError({ projectId, step, error });
      return undefined;
    }
  }
}
