import type { CreateProjectRequest, UpdateProjectRequest } from '@openfleet/shared';
import type { DocsFolderService } from '../notes/docsFolderService.js';
import { ProjectNotFoundError } from './projectErrors.js';
import type { ProjectRecord, ProjectRepository } from './projectRepository.js';

export interface ProjectServiceDeps {
  projects: ProjectRepository;
  docs: Pick<DocsFolderService, 'prepareFolder' | 'attachFolder'>;
  clock: () => string;
  newId: () => string;
  /** Called after a project gets a docs folder (on create or on change), so the daemon can reconcile and watch it. */
  onDocsFolderSet?: (projectId: string) => void;
}

/**
 * Creates projects and sets their docs folder. A folder is accepted only when it is an absolute, writable directory
 * whose docs subfolders stay inside it; the notes already in it are imported. A refused request changes nothing.
 */
export class ProjectService {
  constructor(private readonly deps: ProjectServiceDeps) {}

  create(request: CreateProjectRequest): ProjectRecord {
    const { docsFolderPath } = request;
    if (docsFolderPath !== undefined) this.deps.docs.prepareFolder(docsFolderPath);
    const record: ProjectRecord = { id: this.deps.newId(), name: request.name, docsFolderPath: docsFolderPath ?? null, createdAt: this.deps.clock() };
    this.deps.projects.insert(record);
    if (docsFolderPath !== undefined) this.importNotesOrForget(record, docsFolderPath);
    return record;
  }

  update(projectId: string, patch: UpdateProjectRequest): ProjectRecord {
    this.requireProject(projectId);
    const { docsFolderPath } = patch;
    if (docsFolderPath !== undefined) this.acceptFolder(projectId, docsFolderPath);
    this.deps.projects.update(projectId, patch);
    if (docsFolderPath !== undefined) this.deps.onDocsFolderSet?.(projectId);
    return this.requireProject(projectId);
  }

  private acceptFolder(projectId: string, docsFolderPath: string): void {
    this.deps.docs.prepareFolder(docsFolderPath);
    this.deps.docs.attachFolder(projectId, docsFolderPath);
  }

  /** The row must exist for the notes to point at it, so a refused import removes the row it just made. */
  private importNotesOrForget(record: ProjectRecord, docsFolderPath: string): void {
    try {
      this.deps.docs.attachFolder(record.id, docsFolderPath);
    } catch (error) {
      this.deps.projects.delete(record.id);
      throw error;
    }
    this.deps.onDocsFolderSet?.(record.id);
  }

  private requireProject(projectId: string): ProjectRecord {
    const project = this.deps.projects.get(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);
    return project;
  }
}
