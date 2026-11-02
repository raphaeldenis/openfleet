import type { ToolList } from '@openfleet/shared';
import { TOOL_CATALOG } from '../mcp/toolCatalog.js';
import { json, type Router } from './router.js';

const byName = (left: { name: string }, right: { name: string }): number => left.name.localeCompare(right.name);

const catalogedTools = (): ToolList => ({
  items: Object.entries(TOOL_CATALOG).map(([name, { domain, category }]) => ({ name, domain, category })).sort(byName),
});

/** The tool catalog for the human: read only, under /api behind the admin token, none under /mcp. */
export function registerToolRoutes(router: Router): void {
  router.add('GET', '/api/tools', ({ res }) => json(res, 200, catalogedTools()));
}
