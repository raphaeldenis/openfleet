import type { ServerResponse } from 'node:http';
import type { ManagerSpec, SessionSpec } from '@openfleet/shared';
import { ModelIdSchema, PERMISSION_MODES, SessionSpecSchema } from '@openfleet/shared';
import { z } from 'zod';
import { ApprovalError, type ApprovalService } from '../governance/approvalService.js';
import type { FakeHandle } from '../harness/fakeHarness.js';
import type { ManagerService } from '../managers/managerService.js';
import type { PulseScheduler } from '../managers/pulseScheduler.js';
import { listAvailableModels, ModelConfigReadOnlyError, ModelConfigUnreadableError, ModelTablePatchSchema, resolveModel, saveModelPatch, type ModelTable } from '../models.js';
import { DaemonShuttingDownError, SessionClosedError, SessionReopenError, type SessionService } from '../sessions/sessionService.js';
import { json, Router } from './router.js';

// Used by the messages, permission-mode and model routes: each can hit a session that closed or a daemon
// that started shutting down between the request landing and the session-service call running.
function respondToLifecycleErrors(res: ServerResponse, run: () => void): void {
  try {
    run();
  } catch (error) {
    if (error instanceof SessionClosedError) return json(res, 409, { error: 'session_closed' });
    if (error instanceof DaemonShuttingDownError) return json(res, 503, { error: 'daemon_shutting_down' });
    throw error;
  }
}

const CreateSessionSchema = SessionSpecSchema.extend({ repoPath: z.string().optional(), branchName: z.string().optional() });

const RenameSessionSchema = z
  .object({ name: z.string().trim().min(1).max(100).optional(), emoji: z.string().trim().min(1).max(32).optional() })
  .refine((patch) => patch.name !== undefined || patch.emoji !== undefined, { message: 'name or emoji is required' });

export function registerRestRoutes(router: Router, deps: { sessions: SessionService; approvals: ApprovalService; modelTable: ModelTable; modelConfigPath: string; managers: ManagerService; pulseScheduler: PulseScheduler }): void {
  const servedRungs = (): ModelTable => {
    const { haiku, sonnet, opus, fable } = deps.modelTable;
    return { haiku, sonnet, opus, fable };
  };

  router.add('GET', '/api/sessions', ({ res }) => json(res, 200, deps.sessions.list()));

  router.add('GET', '/api/models', ({ res }) => json(res, 200, servedRungs()));

  router.add('GET', '/api/models/available', async ({ res }) => json(res, 200, { models: await listAvailableModels() }));

  // The table is updated in place: the MCP handler and the session routes hold this same object, so the
  // next launch or model switch resolves against the new ids. Running sessions keep the id they resolved.
  router.add('PUT', '/api/models', async ({ res, body }) => {
    const patch = ModelTablePatchSchema.parse(body);
    try {
      saveModelPatch(deps.modelConfigPath, patch);
    } catch (error) {
      if (error instanceof ModelConfigUnreadableError) return json(res, 409, { error: 'config_unreadable', detail: error.message });
      if (error instanceof ModelConfigReadOnlyError) return json(res, 409, { error: 'config_read_only', detail: error.message });
      throw error;
    }
    Object.assign(deps.modelTable, patch);
    json(res, 200, { models: servedRungs() });
  });

  router.add('POST', '/api/sessions', async ({ res, body }) => {
    const requestedSpec = CreateSessionSchema.parse(body);
    const spec = requestedSpec.model ? { ...requestedSpec, model: resolveModel(deps.modelTable, requestedSpec.model) } : requestedSpec;
    const hasRepo = spec.repoPath !== undefined && spec.branchName !== undefined;
    try {
      const session = spec.manager
        ? await deps.managers.createManagerSession(spec as SessionSpec & { manager: ManagerSpec })
        : hasRepo
          ? await deps.sessions.createInWorktree({ ...spec, repoPath: spec.repoPath!, branchName: spec.branchName! })
          : await deps.sessions.create(spec);
      json(res, 201, session);
    } catch (error) {
      if (!(error instanceof DaemonShuttingDownError)) throw error;
      json(res, 503, { error: 'daemon_shutting_down' });
    }
  });

  router.add('POST', '/api/managers/:id/pulse', ({ res, params }) => {
    if (!deps.managers.get(params.id!)) return json(res, 404, { error: 'not_found' });
    const result = deps.pulseScheduler.pulseNow(params.id!);
    if (!result) return json(res, 409, { error: 'session_closed' });
    json(res, 200, result.coalesced ? { pulsed: false, coalesced: true } : { pulsed: true });
  });

  router.add('PATCH', '/api/sessions/:id', ({ res, params, body }) => {
    if (!deps.sessions.get(params.id!)) return json(res, 404, { error: 'not_found' });
    const patch = RenameSessionSchema.parse(body);
    json(res, 200, deps.sessions.rename(params.id!, patch));
  });

  router.add('POST', '/api/sessions/:id/messages', ({ res, params, body }) => {
    if (!deps.sessions.get(params.id!)) return json(res, 404, { error: 'not_found' });
    const { body: text } = z.object({ body: z.string().min(1) }).parse(body);
    respondToLifecycleErrors(res, () => json(res, 200, deps.sessions.sendMessage({ sessionId: params.id!, body: text })));
  });

  router.add('POST', '/api/sessions/:id/reopen', ({ res, params }) => {
    if (!deps.sessions.get(params.id!)) return json(res, 404, { error: 'not_found' });
    try {
      json(res, 200, deps.sessions.reopen(params.id!));
    } catch (error) {
      if (error instanceof DaemonShuttingDownError) return json(res, 503, { error: 'daemon_shutting_down' });
      if (!(error instanceof SessionReopenError)) throw error;
      json(res, error.code === 'launch_failed' ? 500 : 409, { error: error.code });
    }
  });

  router.add('POST', '/api/sessions/:id/permission-mode', ({ res, params, body }) => {
    if (!deps.sessions.get(params.id!)) return json(res, 404, { error: 'not_found' });
    const { mode } = z.object({ mode: z.enum(PERMISSION_MODES) }).parse(body);
    respondToLifecycleErrors(res, () => json(res, 200, deps.sessions.updatePermissionMode(params.id!, mode)));
  });

  router.add('POST', '/api/sessions/:id/input', ({ res, params, body }) => {
    if (!deps.sessions.get(params.id!)) return json(res, 404, { error: 'not_found' });
    const { data } = z.object({ data: z.string() }).parse(body);
    deps.sessions.writeRaw(params.id!, data);
    json(res, 200, {});
  });

  router.add('POST', '/api/sessions/:id/model', ({ res, params, body }) => {
    if (!deps.sessions.get(params.id!)) return json(res, 404, { error: 'not_found' });
    const { model } = z.object({ model: ModelIdSchema }).parse(body);
    respondToLifecycleErrors(res, () => json(res, 200, deps.sessions.updateModel(params.id!, resolveModel(deps.modelTable, model))));
  });

  router.add('POST', '/api/sessions/:id/resize', ({ res, params, body }) => {
    const { cols, rows } = z.object({ cols: z.number().int().positive(), rows: z.number().int().positive() }).parse(body);
    deps.sessions.resize(params.id!, cols, rows);
    json(res, 200, {});
  });

  router.add('GET', '/api/sessions/:id/output', ({ res, params }) => {
    if (!deps.sessions.get(params.id!)) return json(res, 404, { error: 'not_found' });
    json(res, 200, { output: deps.sessions.recentOutput(params.id!) });
  });

  // ponytail: exposes the hook token to the operator UI/e2e; scope it down when the daemon leaves localhost
  router.add('GET', '/api/sessions/:id/tokens', ({ res, params }) => {
    const tokens = deps.sessions.tokens(params.id!);
    if (!tokens) return json(res, 404, { error: 'not_found' });
    json(res, 200, { hookToken: tokens.hookToken });
  });

  router.add('POST', '/api/sessions/:id/fake-output', ({ res, params, body }) => {
    const session = deps.sessions.get(params.id!);
    if (!session || session.harness !== 'fake') return json(res, 404, { error: 'not_found' });
    const { data } = z.object({ data: z.string() }).parse(body);
    (deps.sessions.harnessHandle(params.id!) as FakeHandle | undefined)?.emitData(data);
    json(res, 200, {});
  });

  router.add('POST', '/api/sessions/:id/close', async ({ res, params }) => {
    await deps.sessions.close(params.id!);
    json(res, 200, {});
  });

  router.add('GET', '/api/approvals', ({ res }) => json(res, 200, deps.approvals.listPending()));

  router.add('POST', '/api/approvals/:id/decide', ({ res, params, body }) => {
    const input = z.object({ behavior: z.enum(['allow', 'deny']), reason: z.string().optional() }).parse(body);
    try {
      json(res, 200, deps.approvals.decide({ approvalId: params.id!, ...input }));
    } catch (error) {
      if (!(error instanceof ApprovalError)) throw error;
      json(res, error.code === 'not_found' ? 404 : 409, { error: error.code });
    }
  });
}
