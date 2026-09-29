import { MAX_NOTE_PAGE_LIMIT, pageQuerySchema, type Page, type Project } from '@openfleet/shared';
import type { ProjectRepository } from '../projects/projectRepository.js';
import { json, queryParams, type Router } from './router.js';

const ListProjectsQuerySchema = pageQuerySchema(MAX_NOTE_PAGE_LIMIT);

export function registerProjectRoutes(router: Router, projects: ProjectRepository): void {
  router.add('GET', '/api/projects', ({ req, res }) => {
    const { limit, offset } = ListProjectsQuerySchema.parse(queryParams(req));
    const all = projects.list().map(({ id, name, docsFolderPath }): Project => ({ id, name, docsFolderPath }));
    const page: Page<Project> = { items: all.slice(offset, offset + limit), total: all.length, limit, offset };
    json(res, 200, page);
  });
}
