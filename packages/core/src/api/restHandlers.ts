import type { ManagerSpec, SessionSpec } from '@openfleet/shared';
import { SessionSpecSchema } from '@openfleet/shared';
import { z } from 'zod';
import { ApprovalError, type ApprovalService } from '../governance/approvalService.js';
import type { FakeHandle } from '../harness/fakeHarness.js';
import type { ManagerService } from '../managers/managerService.js';
import type { PulseScheduler } from '../managers/pulseScheduler.js';
import { resolveModel, type ModelTable } from '../models.js';
import { SessionClosedError, type SessionService } from '../sessions/sessionService.js';
import { json, Router } from './router.js';

const CreateSessionSchema = SessionSpecSchema.extend({ repoPath: z.string().optional(), branchName: z.string().optional() });

export function registerRestRoutes(router: Router, deps: { sessions: SessionService; approvals: ApprovalService; modelTable: ModelTable; managers: ManagerService; pulseScheduler: PulseScheduler }): void {
  router.add('GET', '/api/sessions', ({ res }) => json(res, 200, deps.sessions.list()));

  router.add('POST', '/api/sessions', async ({ res, body }) => {
    const spec = CreateSessionSchema.parse(body);
    const hasRepo = spec.repoPath !== undefined && spec.branchName !== undefined;
    const session = spec.manager
      ? await deps.managers.createManagerSession(spec as SessionSpec & { manager: ManagerSpec })
      : hasRepo
        ? await deps.sessions.createInWorktree({ ...spec, repoPath: spec.repoPath!, branchName: spec.branchName! })
        : await deps.sessions.create(spec);
    json(res, 201, session);
  });

  router.add('POST', '/api/managers/:id/pulse', ({ res, params }) => {
    if (!deps.managers.get(params.id!)) return json(res, 404, { error: 'not_found' });
    deps.pulseScheduler.pulseNow(params.id!);
    json(res, 200, { pulsed: true });
  });

  router.add('POST', '/api/sessions/:id/messages', ({ res, params, body }) => {
    if (!deps.sessions.get(params.id!)) return json(res, 404, { error: 'not_found' });
    const { body: text } = z.object({ body: z.string().min(1) }).parse(body);
    json(res, 200, deps.sessions.sendMessage({ sessionId: params.id!, body: text }));
  });

  router.add('POST', '/api/sessions/:id/input', ({ res, params, body }) => {
    if (!deps.sessions.get(params.id!)) return json(res, 404, { error: 'not_found' });
    const { data } = z.object({ data: z.string() }).parse(body);
    deps.sessions.writeRaw(params.id!, data);
    json(res, 200, {});
  });

  router.add('POST', '/api/sessions/:id/model', ({ res, params, body }) => {
    if (!deps.sessions.get(params.id!)) return json(res, 404, { error: 'not_found' });
    const { model } = z.object({ model: z.string().min(1) }).parse(body);
    try {
      json(res, 200, deps.sessions.updateModel(params.id!, resolveModel(deps.modelTable, model)));
    } catch (error) {
      if (!(error instanceof SessionClosedError)) throw error;
      json(res, 409, { error: 'session_closed' });
    }
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
