import {
  CreateProjectRequestSchema, MAX_NOTE_PAGE_LIMIT, pageQuerySchema, UpdateProjectRequestSchema, type Page, type Project,
} from '@openfleet/shared';
import type { ProjectRecord, ProjectRepository } from '../projects/projectRepository.js';
import type { ProjectService } from '../projects/projectService.js';
import { json, queryParams, type Router } from './router.js';

const ListProjectsQuerySchema = pageQuerySchema(MAX_NOTE_PAGE_LIMIT);

const projectOf = ({ id, name, docsFolderPath, postCreateHookScript, postCreateHookTimeoutSeconds }: ProjectRecord): Project => ({
  id, name, docsFolderPath,
  ...(postCreateHookScript && { postCreateHookScript }),
  ...(postCreateHookScript && postCreateHookTimeoutSeconds && { postCreateHookTimeoutSeconds }),
});

export function registerProjectRoutes(router: Router, deps: { projects: ProjectRepository; projectService?: ProjectService }): void {
  router.add('GET', '/api/projects', ({ req, res }) => {
    const { limit, offset } = ListProjectsQuerySchema.parse(queryParams(req));
    const all = deps.projects.list().map(projectOf);
    const page: Page<Project> = { items: all.slice(offset, offset + limit), total: all.length, limit, offset };
    json(res, 200, page);
  });

  const { projectService } = deps;
  if (!projectService) return;

  router.add('POST', '/api/projects', ({ res, body }) => {
    const request = CreateProjectRequestSchema.parse(body);
    json(res, 201, projectOf(projectService.create(request)));
  });

  router.add('PATCH', '/api/projects/:id', ({ res, params, body }) => {
    const patch = UpdateProjectRequestSchema.parse(body);
    json(res, 200, projectOf(projectService.update(params.id!, patch)));
  });
}
