import { DOCS_ROOT_PATH, UpdateDocsRootRequestSchema } from '@openfleet/shared';
import type { DocsRootSettings } from '../notes/docsRootSettings.js';
import { json, queryParams, type Router } from './router.js';

export function registerDocsRootRoutes(router: Router, deps: { docsRoot: DocsRootSettings }): void {
  router.add('GET', DOCS_ROOT_PATH, ({ req, res }) => json(res, 200, deps.docsRoot.view({ projectName: queryParams(req).projectName })));

  router.add('PATCH', DOCS_ROOT_PATH, ({ res, body }) => {
    const { root } = UpdateDocsRootRequestSchema.parse(body);
    json(res, 200, deps.docsRoot.save(root));
  });
}
