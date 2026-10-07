import { OpenFleetError, type CreateProjectRequest, type UpdateProjectRequest } from '@openfleet/shared';
import { unrunnableReasonOf } from '../git/postCreateHook.js';
import type { DocsFolderService } from '../notes/docsFolderService.js';
import { ProjectNotFoundError } from './projectErrors.js';
import type { ProjectPatch, ProjectRecord, ProjectRepository } from './projectRepository.js';

const UNRUNNABLE_SCRIPT_MESSAGE = {
  not_found: 'the post-create script must be an absolute path to an existing file.',
  not_executable: 'the post-create script is not executable.',
  unsafe_permissions: 'the post-create script must not be writable by group or others.',
} as const;

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
    const current = this.requireProject(projectId);
    const { docsFolderPath } = patch;
    const hookSetting = this.acceptedHookSetting(current, patch);
    if (docsFolderPath !== undefined) this.acceptFolder(projectId, docsFolderPath);
    this.deps.projects.update(projectId, { ...patch, ...hookSetting });
    if (docsFolderPath !== undefined) this.deps.onDocsFolderSet?.(projectId);
    return this.requireProject(projectId);
  }

  /** The hook script and timeout the patch leaves behind: a script that cannot run is refused, a cleared script takes its timeout with it. */
  private acceptedHookSetting(current: ProjectRecord, patch: UpdateProjectRequest): Pick<ProjectPatch, 'postCreateHookScript' | 'postCreateHookTimeoutSeconds'> {
    const { postCreateHookScript, postCreateHookTimeoutSeconds } = patch;
    const touchesHook = postCreateHookScript !== undefined || postCreateHookTimeoutSeconds !== undefined;
    if (!touchesHook) return {};
    const script = postCreateHookScript === undefined ? current.postCreateHookScript ?? null : postCreateHookScript;
    const currentTimeout = current.postCreateHookTimeoutSeconds ?? null;
    if (script !== null && postCreateHookScript !== undefined) this.requireRunnableScript(script);
    const isScriptCleared = script === null;
    const timeout = isScriptCleared ? null : postCreateHookTimeoutSeconds === undefined ? currentTimeout : postCreateHookTimeoutSeconds;
    const isTimeoutWithoutScript = isScriptCleared && postCreateHookTimeoutSeconds !== undefined && postCreateHookTimeoutSeconds !== null;
    if (isTimeoutWithoutScript) throw new OpenFleetError('invalid_body', 'a post-create timeout needs a post-create script.');
    return { postCreateHookScript: script, postCreateHookTimeoutSeconds: timeout };
  }

  private requireRunnableScript(script: string): void {
    const reason = unrunnableReasonOf(script);
    if (reason) throw new OpenFleetError('invalid_body', UNRUNNABLE_SCRIPT_MESSAGE[reason]);
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
