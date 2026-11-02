import { PlaybookInputsSchema, PlaybookNameSchema, PlaybookPolicySchema } from '@openfleet/shared';
import { z } from 'zod';
import { parsePlaybookCell } from '../playbooks/cellParsing.js';
import type { PlaybookContent, PlaybookRecord } from '../playbooks/playbookRepository.js';
import type { PlaybookService } from '../playbooks/playbookService.js';
import { json, queryParams, type Router } from './router.js';

const CellsSchema = z.array(z.record(z.string(), z.unknown()));
const RevisionSchema = z.int().min(1);

const ListQuerySchema = z.object({ projectId: z.string().min(1) });
const CreateBodySchema = z.strictObject({
  projectId: z.string().min(1), name: PlaybookNameSchema.optional(), inputs: z.unknown().optional(), cells: CellsSchema.optional(),
  policy: PlaybookPolicySchema.optional(), agentLocked: z.boolean().optional(),
});
const ReplaceBodySchema = z.strictObject({
  expectedRev: RevisionSchema, name: PlaybookNameSchema.optional(), inputs: z.unknown().optional(), cells: CellsSchema.optional(),
  policy: PlaybookPolicySchema.optional(), agentLocked: z.boolean().optional(),
});

/** A playbook as the desktop reads it: the record, the secret names its cells reference and the declared names no cell references any more. */
const answerOf = (playbooks: PlaybookService, playbook: PlaybookRecord) => {
  const { referenced, unreferenced } = playbooks.secretNamesOf(playbook);
  return { ...playbook, secrets: referenced, unreferencedSecrets: unreferenced };
};

/**
 * The human side of the playbooks: every route sits under /api, behind the admin token; the only writer that ignores the lock `agentLocked`.
 * Each mutation is recorded as an action of the human by the router.
 */
export function registerPlaybookRoutes(router: Router, deps: { playbooks: PlaybookService }): void {
  const { playbooks } = deps;

  router.add('GET', '/api/playbooks', ({ req, res }) => {
    const { projectId } = ListQuerySchema.parse(queryParams(req));
    json(res, 200, playbooks.list(projectId).map((playbook) => answerOf(playbooks, playbook)));
  });

  router.add('POST', '/api/playbooks', ({ res, body }) => {
    json(res, 201, answerOf(playbooks, playbooks.create({ ...CreateBodySchema.parse(body), writer: 'admin' })));
  });

  router.add('GET', '/api/playbooks/:id', ({ res, params }) => {
    json(res, 200, answerOf(playbooks, playbooks.getById(params.id!)));
  });

  router.add('PUT', '/api/playbooks/:id', ({ res, params, body }) => {
    const { expectedRev, name, inputs, cells, policy, agentLocked } = ReplaceBodySchema.parse(body);
    const replacement: PlaybookContent = {
      ...(name !== undefined && { name }), ...(policy !== undefined && { policy }), ...(agentLocked !== undefined && { agentLocked }),
      ...(inputs !== undefined && { inputs: PlaybookInputsSchema.parse(inputs) }),
      ...(cells !== undefined && { flow: { cells: cells.map(parsePlaybookCell) } }),
    };
    json(res, 200, answerOf(playbooks, playbooks.edit(params.id!, () => replacement, { writer: 'admin', expectedRev })));
  });

  router.add('DELETE', '/api/playbooks/:id', ({ res, params }) => {
    playbooks.delete(params.id!, { writer: 'admin' });
    json(res, 200, { deleted: params.id! });
  });
}
