import { homedir } from 'node:os';
import {
  CreateProjectRequestSchema, DetectRepositoryRequestSchema, MAX_NOTE_PAGE_LIMIT, pageQuerySchema, UpdateProjectRequestSchema, type Page, type Project,
} from '@openfleet/shared';
import type { DataStoreRepository } from '../stores/dataStoreRepository.js';
import { rowGuardWarningOf } from '../stores/rowGuard.js';
import { nodeDocsFolderIdentity, type DocsFolderIdentity } from '../projects/docsFolderIdentity.js';
import { detectRepository } from '../projects/repositoryDetector.js';
import type { ProjectRecord, ProjectRepository } from '../projects/projectRepository.js';
import type { ProjectService } from '../projects/projectService.js';
import { json, queryParams, type Router } from './router.js';

const ListProjectsQuerySchema = pageQuerySchema(MAX_NOTE_PAGE_LIMIT);

/** Reads the identity of each folder once: a request that answers with many projects stats every folder a single time. */
function memoizedDocsFolderIdentity(): DocsFolderIdentity {
  const identityByPath = new Map<string, string | null>();
  return (path) => {
    if (!identityByPath.has(path)) identityByPath.set(path, nodeDocsFolderIdentity(path));
    return identityByPath.get(path) ?? null;
  };
}

/** Names of the other projects whose docs folder is the same directory as this project's. */
function namesOfProjectsSharingFolder(project: ProjectRecord, allProjects: ProjectRecord[], identityOf: DocsFolderIdentity): string[] {
  const identity = project.docsFolderPath === null ? null : identityOf(project.docsFolderPath);
  if (identity === null) return [];
  return allProjects
    .filter((other) => other.id !== project.id && other.docsFolderPath !== null && identityOf(other.docsFolderPath) === identity)
    .map((other) => other.name);
}

type StoreColumns = Pick<DataStoreRepository, 'listStores' | 'listColumns'>;

/** The warning only exists while the guard is on: a project without the guard has nothing that could stay silent. */
function rowGuardWarningOfProject({ id, rowGuardEnabled }: ProjectRecord, storeColumns: StoreColumns | undefined): string | undefined {
  if (!rowGuardEnabled || storeColumns === undefined) return undefined;
  const columnsOfEachStore = storeColumns.listStores(id).map((store) => storeColumns.listColumns(store.id));
  return rowGuardWarningOf(columnsOfEachStore);
}

const projectOf = (record: ProjectRecord, allProjects: ProjectRecord[], storeColumns?: StoreColumns, identityOf: DocsFolderIdentity = memoizedDocsFolderIdentity()): Project => {
  const { id, name, docsFolderPath, postCreateHookScript, postCreateHookTimeoutSeconds, rowGuardEnabled, sharedRepo, escalation } = record;
  const docsFolderSharedWith = namesOfProjectsSharingFolder(record, allProjects, identityOf);
  const rowGuardWarning = rowGuardWarningOfProject(record, storeColumns);
  return {
    id, name, docsFolderPath,
    ...(docsFolderSharedWith.length > 0 && { docsFolderSharedWith }),
    ...(rowGuardWarning !== undefined && { rowGuardWarning }),
    ...(postCreateHookScript && { postCreateHookScript }),
    ...(postCreateHookScript && postCreateHookTimeoutSeconds && { postCreateHookTimeoutSeconds }),
    ...(rowGuardEnabled && { rowGuardEnabled }),
    ...(sharedRepo && { sharedRepo }),
    ...(escalation && { escalation }),
  };
};

export function registerProjectRoutes(router: Router, deps: { projects: ProjectRepository; projectService?: ProjectService; storeRepo?: StoreColumns; homeDirectory?: string }): void {
  const homeDirectory = deps.homeDirectory ?? homedir();

  router.add('GET', '/api/projects', ({ req, res }) => {
    const { limit, offset } = ListProjectsQuerySchema.parse(queryParams(req));
    const records = deps.projects.list();
    const identityOfFolder = memoizedDocsFolderIdentity();
    const all = records.map((record) => projectOf(record, records, deps.storeRepo, identityOfFolder));
    const page: Page<Project> = { items: all.slice(offset, offset + limit), total: all.length, limit, offset };
    json(res, 200, page);
  });

  router.add('POST', '/api/projects/detect', ({ res, body }) => {
    const { repositoryPath } = DetectRepositoryRequestSchema.parse(body);
    const registeredFolders = deps.projects.list().flatMap(({ docsFolderPath }) => docsFolderPath ?? []);
    json(res, 200, detectRepository(repositoryPath, { allowedRoots: [homeDirectory, ...registeredFolders] }));
  });

  const { projectService } = deps;
  if (!projectService) return;

  router.add('POST', '/api/projects', ({ res, body }) => {
    const request = CreateProjectRequestSchema.parse(body);
    json(res, 201, projectOf(projectService.create(request), deps.projects.list(), deps.storeRepo));
  });

  router.add('PATCH', '/api/projects/:id', ({ res, params, body }) => {
    const patch = UpdateProjectRequestSchema.parse(body);
    json(res, 200, projectOf(projectService.update(params.id!, patch), deps.projects.list(), deps.storeRepo));
  });
}
