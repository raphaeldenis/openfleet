import type { CloseHandoffResult, ManagerSpec, SessionSpec } from '@openfleet/shared';
import { CloseSessionRequestSchema, ModelIdSchema, OpenFleetError, PERMISSION_MODES, SessionSpecSchema } from '@openfleet/shared';
import { z } from 'zod';
import type { ApprovalService } from '../governance/approvalService.js';
import type { FakeHandle } from '../harness/fakeHarness.js';
import type { ManagerService } from '../managers/managerService.js';
import type { PulseScheduler } from '../managers/pulseScheduler.js';
import { listAvailableModels, ModelTablePatchSchema, resolveModel, saveModelPatch, type ModelTable } from '../models.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { TodoTracker } from '../todos/todoTracker.js';
import type { HandoverLedger } from '../workingState/handoverLedger.js';
import type { WorkingStateService } from '../workingState/workingStateService.js';
import type { HandoffRouteDeps } from './handoffRoutes.js';
import { json, Router } from './router.js';
import type { WsTicketStore } from './wsTicketStore.js';

const NO_HANDOFF_TARGET: CloseHandoffResult = { status: 'skipped', reason: 'target_unavailable' };

const notFound = (what: string) => new OpenFleetError('not_found', `the ${what} does not exist.`);

const CreateSessionSchema = SessionSpecSchema.extend({ repoPath: z.string().optional(), branchName: z.string().optional() });

const RenameSessionSchema = z
  .object({ name: z.string().trim().min(1).max(100).optional(), emoji: z.string().trim().min(1).max(32).optional() })
  .refine((patch) => patch.name !== undefined || patch.emoji !== undefined, { message: 'name or emoji is required' });

export function registerRestRoutes(router: Router, deps: { sessions: SessionService; approvals: ApprovalService; modelTable: ModelTable; modelConfigPath: string; managers: ManagerService; pulseScheduler: PulseScheduler; wsTickets: WsTicketStore; workingStates?: WorkingStateService; handoverLedger?: HandoverLedger; todos?: TodoTracker; handoff?: Pick<HandoffRouteDeps, 'writeHandoffOnClose'>; e2eRoutes?: boolean }): void {
  const servedRungs = (): ModelTable => {
    const { haiku, sonnet, opus, fable } = deps.modelTable;
    return { haiku, sonnet, opus, fable };
  };

  const requireSession = (sessionId: string): void => {
    if (!deps.sessions.get(sessionId)) throw notFound('session');
  };

  router.add('GET', '/api/sessions', ({ res }) => json(res, 200, deps.sessions.list()));

  // AUD-27: the desktop shell calls this, bearer-authenticated like every other /api/ route, right before
  // opening (or reopening) the WS — the ticket it gets back is what actually authorizes that connection.
  router.add('POST', '/api/ws-ticket', ({ res }) => json(res, 200, { ticket: deps.wsTickets.issue() }));

  router.add('GET', '/api/models', ({ res }) => json(res, 200, servedRungs()));

  router.add('GET', '/api/models/available', async ({ res }) => json(res, 200, { models: await listAvailableModels() }));

  // The table is updated in place: the MCP handler and the session routes hold this same object, so the
  // next launch or model switch resolves against the new ids. Running sessions keep the id they resolved.
  router.add('PUT', '/api/models', async ({ res, body }) => {
    const patch = ModelTablePatchSchema.parse(body);
    saveModelPatch(deps.modelConfigPath, patch);
    Object.assign(deps.modelTable, patch);
    json(res, 200, { models: servedRungs() });
  });

  router.add('POST', '/api/sessions', async ({ res, body }) => {
    const requestedSpec = CreateSessionSchema.parse(body);
    const spec = requestedSpec.model ? { ...requestedSpec, model: resolveModel(deps.modelTable, requestedSpec.model) } : requestedSpec;
    const hasRepo = spec.repoPath !== undefined && spec.branchName !== undefined;
    const session = spec.manager
      ? await deps.managers.createManagerSession(spec as SessionSpec & { manager: ManagerSpec })
      : hasRepo
        ? await deps.sessions.createInWorktree({ ...spec, repoPath: spec.repoPath!, branchName: spec.branchName! })
        : await deps.sessions.create(spec);
    json(res, 201, session);
  });

  router.add('POST', '/api/managers/:id/pulse', ({ res, params }) => {
    if (!deps.managers.get(params.id!)) throw notFound('manager');
    const result = deps.pulseScheduler.pulseNow(params.id!);
    if (!result) throw new OpenFleetError('session_closed', 'the manager session is closed.');
    json(res, 200, result.coalesced ? { pulsed: false, coalesced: true } : { pulsed: true });
  });

  router.add('PATCH', '/api/sessions/:id', ({ res, params, body }) => {
    requireSession(params.id!);
    const patch = RenameSessionSchema.parse(body);
    json(res, 200, deps.sessions.rename(params.id!, patch));
  });

  router.add('POST', '/api/sessions/:id/messages', ({ res, params, body }) => {
    requireSession(params.id!);
    const { body: text, messageId } = z.object({ body: z.string().min(1), messageId: z.uuid().optional() }).parse(body);
    json(res, 200, deps.sessions.sendMessage({ sessionId: params.id!, body: text, messageId }));
  });

  router.add('POST', '/api/sessions/:id/reopen', ({ res, params }) => {
    requireSession(params.id!);
    json(res, 200, deps.sessions.reopen(params.id!));
  });

  router.add('POST', '/api/sessions/:id/permission-mode', ({ res, params, body }) => {
    requireSession(params.id!);
    const { mode } = z.object({ mode: z.enum(PERMISSION_MODES) }).parse(body);
    json(res, 200, deps.sessions.updatePermissionMode(params.id!, mode));
  });

  router.add('POST', '/api/sessions/:id/input', ({ res, params, body }) => {
    requireSession(params.id!);
    const { data } = z.object({ data: z.string() }).parse(body);
    deps.sessions.writeRaw(params.id!, data);
    json(res, 200, {});
  });

  router.add('POST', '/api/sessions/:id/model', ({ res, params, body }) => {
    requireSession(params.id!);
    const { model } = z.object({ model: ModelIdSchema }).parse(body);
    json(res, 200, deps.sessions.updateModel(params.id!, resolveModel(deps.modelTable, model)));
  });

  router.add('POST', '/api/sessions/:id/resize', ({ res, params, body }) => {
    requireSession(params.id!);
    const { cols, rows } = z.object({ cols: z.number().int().positive(), rows: z.number().int().positive() }).parse(body);
    deps.sessions.resize(params.id!, cols, rows);
    json(res, 200, {});
  });

  router.add('GET', '/api/sessions/:id/output', ({ res, params }) => {
    requireSession(params.id!);
    json(res, 200, { output: deps.sessions.recentOutput(params.id!) });
  });

  // ponytail: exposes the hook token to the operator UI/e2e; scope it down when the daemon leaves localhost
  router.add('GET', '/api/sessions/:id/tokens', ({ res, params }) => {
    const tokens = deps.sessions.tokens(params.id!);
    if (!tokens) throw notFound('session');
    json(res, 200, { hookToken: tokens.hookToken });
  });

  if (deps.e2eRoutes) {
    router.add('POST', '/api/sessions/:id/fake-output', ({ res, params, body }) => {
      const session = deps.sessions.get(params.id!);
      if (!session || session.harness !== 'fake') throw notFound('session');
      const { data } = z.object({ data: z.string() }).parse(body);
      (deps.sessions.harnessHandle(params.id!) as FakeHandle | undefined)?.emitData(data);
      json(res, 200, {});
    });

    router.add('POST', '/api/sessions/:id/fake-exit', ({ res, params, body }) => {
      const session = deps.sessions.get(params.id!);
      if (!session || session.harness !== 'fake') throw notFound('session');
      const { code, conversationNotFound } = z.object({ code: z.number().int(), conversationNotFound: z.boolean().optional() }).parse(body);
      (deps.sessions.harnessHandle(params.id!) as FakeHandle | undefined)?.emitExit(code, { wasConversationNotFound: conversationNotFound ?? false });
      json(res, 200, {});
    });

    router.add('POST', '/api/managers/:id/fail-next-pulses', ({ res, params, body }) => {
      if (!deps.managers.get(params.id!)) throw notFound('manager');
      const { count } = z.object({ count: z.number().int().min(1).max(100) }).parse(body);
      deps.pulseScheduler.failNextTicks(params.id!, count);
      json(res, 200, {});
    });
  }

  router.add('POST', '/api/sessions/:id/close', async ({ res, params, body }) => {
    const sessionId = params.id!;
    requireSession(sessionId);
    const { writeHandoff } = CloseSessionRequestSchema.parse(body ?? {});
    const handoff = writeHandoff ? (deps.handoff?.writeHandoffOnClose(sessionId) ?? NO_HANDOFF_TARGET) : undefined;
    await deps.sessions.close(sessionId);
    json(res, 200, handoff ? { handoff } : {});
  });

  const { workingStates } = deps;
  if (workingStates) {
    router.add('GET', '/api/sessions/:id/working-state', ({ res, params }) => {
      requireSession(params.id!);
      const state = workingStates.get(params.id!);
      if (!state) throw new OpenFleetError('no_state', 'the session has no working state yet.');
      json(res, 200, state);
    });
  }

  const { todos } = deps;
  if (todos) {
    router.add('GET', '/api/sessions/:id/todos', async ({ res, params }) => {
      requireSession(params.id!);
      json(res, 200, await todos.read(params.id!));
    });
  }

  const { handoverLedger } = deps;
  if (handoverLedger) {
    router.add('GET', '/api/sessions/:id/handovers', ({ res, params }) => {
      requireSession(params.id!);
      json(res, 200, handoverLedger.list(params.id!));
    });
  }

  router.add('GET', '/api/approvals', ({ res })=> json(res, 200, deps.approvals.listPending()));

  router.add('POST', '/api/approvals/:id/decide', ({ res, params, body }) => {
    const input = z.object({ behavior: z.enum(['allow', 'deny']), reason: z.string().optional() }).parse(body);
    json(res, 200, deps.approvals.decide({ approvalId: params.id!, ...input }));
  });
}
