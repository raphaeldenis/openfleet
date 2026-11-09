import { HUMAN_ACTOR, OpenFleetError, PlaybookInputsSchema, PlaybookNameSchema, PlaybookPolicySchema } from '@openfleet/shared';
import { z } from 'zod';
import { parsePlaybookCell } from '../playbooks/cellParsing.js';
import type { PlaybookContent, PlaybookRecord } from '../playbooks/playbookRepository.js';
import type { PlaybookApprovals } from '../playbooks/playbookApprovals.js';
import type { PlaybookRunner } from '../playbooks/playbookRunner.js';
import type { PlaybookRunRecord, PlaybookRunRepository } from '../playbooks/playbookRunRepository.js';
import type { PlaybookService } from '../playbooks/playbookService.js';
import { json, queryParams, type Router } from './router.js';

const CellsSchema = z.array(z.record(z.string(), z.unknown()));
const RevisionSchema = z.int().min(1);

const RevisionParamSchema = z.coerce.number().pipe(RevisionSchema);
const RestoreBodySchema = z.strictObject({ expectedRev: RevisionSchema });
const ListQuerySchema =z.object({ projectId: z.string().min(1) });
const DeleteQuerySchema = z.object({ expectedRev: z.coerce.number().pipe(RevisionSchema) });
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

/** What the approval and the runs of playbooks need; without it only the authoring routes exist. */
export interface PlaybookRunning {
  approvals: PlaybookApprovals;
  runner: PlaybookRunner;
  runs: PlaybookRunRepository;
}

const ApproveBodySchema = z.strictObject({ digest: z.string().min(1) });
const RunBodySchema = z.strictObject({ inputs: z.record(z.string(), z.unknown()).optional() });
const RunsQuerySchema = z.object({ playbookId: z.string().min(1) });

/** A run as the desktop reads it: the journal of its steps with outputs already masked. */
const runViewOf = (running: PlaybookRunning, run: PlaybookRunRecord) => ({ ...run, steps: running.runs.stepsOf(run.id) });

/** The approval and the runs. The approval route and the run route are for the human side only: no MCP tool approves a playbook or runs it. */
function registerRunRoutes(router: Router, deps: { playbooks: PlaybookService; running: PlaybookRunning }): void {
  const { playbooks, running } = deps;
  const runOrNotFound = (id: string): PlaybookRunRecord => {
    const run = running.runs.get(id);
    if (run === undefined) throw new OpenFleetError('playbook_run_not_found', 'run not found');
    return run;
  };

  router.add('GET', '/api/playbooks/:id/approval', ({ res, params }) => {
    const approval = running.approvals.preview(playbooks.getById(params.id!));
    json(res, 200, { ...approval, programs: Object.keys(approval.scripts) });
  });

  router.add('POST', '/api/playbooks/:id/approve', ({ res, params, body }) => {
    const { digest } = ApproveBodySchema.parse(body);
    running.approvals.approve(playbooks.getById(params.id!), { digest, by: HUMAN_ACTOR });
    json(res, 200, answerOf(playbooks, playbooks.getById(params.id!)));
  });

  router.add('POST', '/api/playbooks/:id/run', async ({ res, params, body }) => {
    const { inputs } = RunBodySchema.parse(body ?? {});
    const run = await running.runner.start({ playbookId: params.id!, inputs: inputs ?? {}, actorKind: 'admin' });
    json(res, 202, runViewOf(running, run));
  });

  router.add('GET', '/api/playbook-runs', ({ req, res }) => {
    const { playbookId } = RunsQuerySchema.parse(queryParams(req));
    json(res, 200, running.runs.listOfPlaybook(playbookId).map((run) => runViewOf(running, run)));
  });

  router.add('GET', '/api/playbook-runs/:id', ({ res, params }) => {
    json(res, 200, runViewOf(running, runOrNotFound(params.id!)));
  });
}

/**
 * The human side of the playbooks: every route sits under /api, behind the admin token, and a write names the revision it read (PUT in the body, DELETE in the query).
 * The admin token is not a proof of a human, so these routes ignore `agentLocked`, which binds MCP agents only; each mutation is recorded as an action of the human by the router.
 */
export function registerPlaybookRoutes(router: Router, deps: { playbooks: PlaybookService; running?: PlaybookRunning }): void {
  const { playbooks } = deps;
  if (deps.running) registerRunRoutes(router, { playbooks, running: deps.running });

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

  router.add('GET', '/api/playbooks/:id/versions', ({ res, params }) => {
    const current = playbooks.getById(params.id!);
    json(res, 200, { currentContentRev: current.contentRev, versions: playbooks.listVersions(current.id).map(({ flow, inputs, policy, ...summary }) => ({ ...summary, cellCount: flow.cells.length })) });
  });

  router.add('GET', '/api/playbooks/:id/versions/:rev', ({ res, params }) => {
    json(res, 200, playbooks.getVersion(params.id!, RevisionParamSchema.parse(params.rev)));
  });

  router.add('POST', '/api/playbooks/:id/versions/:rev/restore', ({ res, params, body }) => {
    const { expectedRev } = RestoreBodySchema.parse(body);
    json(res, 200, answerOf(playbooks, playbooks.restoreVersion(params.id!, { rev: RevisionParamSchema.parse(params.rev) }, { writer: 'admin', expectedRev })));
  });

  router.add('DELETE', '/api/playbooks/:id',({ req, res, params }) => {
    const { expectedRev } = DeleteQuerySchema.parse(queryParams(req));
    playbooks.delete(params.id!, { writer: 'admin', expectedRev });
    json(res, 200, { deleted: params.id! });
  });
}
