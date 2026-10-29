import { OpenFleetError, projectNoteTitle, renderProjectNote, type CreateProjectRequest, type NoteFolder, type ProjectProfile, type UpdateProjectRequest } from '@openfleet/shared';
import { unrunnableReasonOf } from '../git/postCreateHook.js';
import type { DocsFolderService } from '../notes/docsFolderService.js';
import { withoutRedundantSlashes, type DocsRootSettings } from '../notes/docsRootSettings.js';
import type { NoteRepository } from '../notes/noteRepository.js';
import { nodeDocsFolderIdentity, type DocsFolderIdentity } from './docsFolderIdentity.js';
import { ProjectNotFoundError } from './projectErrors.js';
import type { ProjectPatch, ProjectRecord, ProjectRepository } from './projectRepository.js';

const UNRUNNABLE_SCRIPT_MESSAGE = {
  not_found: 'the post-create script must be an absolute path to an existing file.',
  not_executable: 'the post-create script is not executable.',
  unsafe_permissions: 'the post-create script must not be writable by group or others.',
} as const;

// The docs folder import scans only the four docs subfolders; `specs` is the closest to a project card.
const PROJECT_NOTE_FOLDER: NoteFolder = 'specs';
const PROJECT_NOTE_AUTHOR = 'onboarding';

export interface ProjectServiceDeps {
  projects: ProjectRepository;
  docs: Pick<DocsFolderService, 'prepareFolder' | 'attachFolder' | 'createFileBackedNote'>;
  noteRepo: Pick<NoteRepository, 'list' | 'delete'>;
  /** Creates the folder of a new project under the docs root; without it a new project needs an existing folder. */
  docsRoot?: Pick<DocsRootSettings, 'ensureProjectFolder'>;
  /** Tells whether two paths reach the same directory; defaults to comparing the device and inode. */
  folderIdentity?: DocsFolderIdentity;
  clock: () => string;
  newId: () => string;
  /** Called after a project gets a docs folder (on create or on change), so the daemon can reconcile and watch it. */
  onDocsFolderSet?: (projectId: string) => void;
  /** Called after a refused creation removes the project, so the daemon stops watching its folder. */
  onProjectForgotten?: (projectId: string) => void;
}

/** A project note matches by title, or by a first line that spells the title in any letter case and with any line end. */
function isProjectNote(note: { title: string; bodyMd: string }, title: string): boolean {
  const normalisedTitle = title.toLowerCase();
  const firstLine = note.bodyMd.split(/\r?\n/, 1)[0]!.toLowerCase();
  return note.title.toLowerCase() === normalisedTitle || firstLine === `# ${normalisedTitle}`;
}

/**
 * Creates projects and sets their docs folder. A folder is accepted only when it is an absolute, writable directory
 * whose docs subfolders stay inside it; the notes already in it are imported. A refused request changes nothing.
 */
export class ProjectService {
  private readonly folderIdentity: DocsFolderIdentity;

  constructor(private readonly deps: ProjectServiceDeps) {
    this.folderIdentity = deps.folderIdentity ?? nodeDocsFolderIdentity;
  }

  create(request: CreateProjectRequest): ProjectRecord {
    const { profile } = request;
    const docsFolderPath = request.docsFolderPath === undefined ? undefined : withoutRedundantSlashes(request.docsFolderPath);
    if (docsFolderPath !== undefined) {
      this.refuseFolderOfAnotherProject({ docsFolderPath });
      this.prepareNewProjectFolder(docsFolderPath);
    }
    const record: ProjectRecord = { id: this.deps.newId(), name: request.name, docsFolderPath: docsFolderPath ?? null, createdAt: this.deps.clock() };
    this.deps.projects.insert(record);
    if (docsFolderPath !== undefined) this.importNotesOrForget(record, docsFolderPath);
    if (profile !== undefined) this.writeProjectNoteOrForget(record, profile);
    return record;
  }

  /** A missing folder under the docs root is created first; whatever then stands at the path must pass the docs folder checks. */
  private prepareNewProjectFolder(docsFolderPath: string): void {
    this.deps.docsRoot?.ensureProjectFolder(docsFolderPath);
    this.deps.docs.prepareFolder(docsFolderPath);
  }

  update(projectId: string, patch: UpdateProjectRequest): ProjectRecord {
    const current = this.requireProject(projectId);
    const { docsFolderPath } = patch;
    const hookSetting = this.acceptedHookSetting(current, patch);
    if (docsFolderPath !== undefined) this.acceptFolderChange(current, docsFolderPath);
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

  private isSameFolder(docsFolderPath: string, otherDocsFolderPath: string | null): boolean {
    if (otherDocsFolderPath === null) return false;
    const identity = this.folderIdentity(docsFolderPath);
    return identity !== null && identity === this.folderIdentity(otherDocsFolderPath);
  }

  /** Two projects never get the same folder: the refusal names the project that holds it. Folders already shared are left alone. */
  private refuseFolderOfAnotherProject({ docsFolderPath, exceptProjectId }: { docsFolderPath: string; exceptProjectId?: string }): void {
    const holder = this.deps.projects.list().find((project) => project.id !== exceptProjectId && project.docsFolderPath !== null && this.isSameFolder(docsFolderPath, project.docsFolderPath));
    if (holder === undefined) return;
    throw new OpenFleetError('docs_folder_already_used', `the docs folder is already the folder of the project "${holder.name}".`, {
      hint: 'pick another folder, or move the notes of that project first.',
    });
  }

  /** A project keeps the folder it has, even a shared one; only a different folder must be free. */
  private acceptFolderChange(current: ProjectRecord, docsFolderPath: string): void {
    const isFolderKept = this.isSameFolder(docsFolderPath, current.docsFolderPath);
    if (!isFolderKept) this.refuseFolderOfAnotherProject({ docsFolderPath, exceptProjectId: current.id });
    this.deps.docs.prepareFolder(docsFolderPath);
    this.deps.docs.attachFolder(current.id, docsFolderPath);
  }

  /** The row must exist for the notes to point at it, so a refused import removes the row it just made. */
  private importNotesOrForget(record: ProjectRecord, docsFolderPath: string): void {
    try {
      this.deps.docs.attachFolder(record.id, docsFolderPath);
    } catch (error) {
      this.forgetProject(record.id);
      throw error;
    }
    this.deps.onDocsFolderSet?.(record.id);
  }

  /** A project note already in the folder (imported from it) is kept as written; a refused write removes the project, so no half-set-up project stays. */
  private writeProjectNoteOrForget(record: ProjectRecord, profile: ProjectProfile): void {
    const { name, id: projectId } = record;
    const title = projectNoteTitle(name);
    const isAlreadyWritten = this.deps.noteRepo.list(projectId).some((note) => isProjectNote(note, title));
    if (isAlreadyWritten) return;
    try {
      this.deps.docs.createFileBackedNote({ projectId, folder: PROJECT_NOTE_FOLDER, title, bodyMd: renderProjectNote({ name, ...profile }), author: PROJECT_NOTE_AUTHOR });
    } catch (error) {
      this.forgetProject(projectId);
      throw error;
    }
  }

  /** Removes the project with the notes imported for it (they point at the row) and stops watching its folder. */
  private forgetProject(projectId: string): void {
    for (const note of this.deps.noteRepo.list(projectId)) this.deps.noteRepo.delete(note.id);
    this.deps.projects.delete(projectId);
    this.deps.onProjectForgotten?.(projectId);
  }

  private requireProject(projectId: string): ProjectRecord {
    const project = this.deps.projects.get(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);
    return project;
  }
}
