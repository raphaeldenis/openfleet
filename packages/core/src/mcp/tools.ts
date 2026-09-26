import { MANAGER_ROLE, PERMISSION_MODES, type Approval, type ManagerSpec, type Session } from '@openfleet/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createWorktree, isPathWithin, sameGitRepository } from '../git/worktrees.js';
import { resolveModel, type ModelTable } from '../models.js';
import type { ApprovalService } from '../governance/approvalService.js';
import type { ManagerService } from '../managers/managerService.js';
import { toManagerView } from '../managers/managerView.js';
import type { PulseScheduler } from '../managers/pulseScheduler.js';
import type { SessionService } from '../sessions/sessionService.js';

const ok = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

export interface RegisterToolsDeps {
  sessions: SessionService;
  caller: Session;
  worktreesRoot: string;
  approvals: ApprovalService;
  managers: ManagerService;
  pulseScheduler: PulseScheduler;
  modelTable: ModelTable;
}

export function registerTools(server: McpServer, deps: RegisterToolsDeps): void {
  const { sessions, caller, approvals, managers, pulseScheduler, modelTable } = deps;
  const isInLineage = (target: Session) => target.id === caller.id || target.parentId === caller.id || target.id === caller.parentId;

  const pendingPermissionFor = (sessionId: string): { toolName: string; ageSeconds: number } | undefined => {
    const pending = approvals.listPending().find((a: Approval) => a.sessionId === sessionId);
    if (!pending) return undefined;
    return { toolName: pending.toolName, ageSeconds: Math.floor((Date.now() - new Date(pending.createdAt).getTime()) / 1000) };
  };

  const isDescendant = (target: Session): boolean => {
    let current: Session | undefined = target;
    while (current?.parentId) {
      if (current.parentId === caller.id) return true;
      current = sessions.get(current.parentId);
    }
    return false;
  };

  server.registerTool('get_session_status', { description: 'State of your session or one in your lineage', inputSchema: { session_id: z.string().optional() } }, async ({ session_id }) => {
    const target = sessions.get(session_id ?? caller.id);
    if (!target || !isInLineage(target)) return fail('session not found or outside your lineage');
    return ok(target);
  });

  server.registerTool('list_children', { description: 'Sessions you spawned', inputSchema: {} }, async () => ok(sessions.list().filter((s) => s.parentId === caller.id)));

  server.registerTool('list_sessions', { description: 'You, your children, and every descendant beneath them', inputSchema: {} }, async () =>
    ok(sessions.list().filter((s) => s.id === caller.id || isDescendant(s))),
  );

  server.registerTool('send_session_message', { description: 'Send a message to a child (or your parent). Queued if it is busy, delivered on its next idle turn.', inputSchema: { target_uuid: z.string(), body: z.string().min(1) } }, async ({ target_uuid, body }) => {
    const target = sessions.get(target_uuid);
    if (!target || !isInLineage(target) || target.id === caller.id) return fail('target not found or outside your lineage');
    const result = sessions.sendMessage({ sessionId: target.id, body, fromSessionId: caller.id });
    return ok({ status: result.status, message_id: result.messageId });
  });

  server.registerTool('message_parent', { description: 'Report to the manager that spawned you', inputSchema: { body: z.string().min(1) } }, async ({ body }) => {
    if (!caller.parentId) return fail('this session has no parent');
    const result = sessions.sendMessage({ sessionId: caller.parentId, body, fromSessionId: caller.id });
    return ok({ status: result.status, message_id: result.messageId });
  });

  server.registerTool('create_worktree', { description: 'Create an isolated git worktree for a task', inputSchema: { repo_path: z.string(), branch_name: z.string() } }, async ({ repo_path, branch_name }) => {
    try {
      const isCallersOwnRepo = await sameGitRepository(caller.directory, repo_path);
      if (!isCallersOwnRepo) return fail('repo_path must be the git repository of your own session directory');
      return ok(await createWorktree({ repoPath: repo_path, branchName: branch_name, worktreesRoot: deps.worktreesRoot }));
    } catch (error) {
      return fail((error as Error).message);
    }
  });

  server.registerTool('create_session', { description: 'Spawn a child coding session in a directory (use create_worktree first)', inputSchema: {
    directory: z.string(), name: z.string().min(1), emoji: z.string().optional(), model: z.string().optional(),
    seeded_prompt: z.string().optional(), role: z.string().optional(), permission_mode: z.enum(PERMISSION_MODES).optional(),
    manager: z.object({ pulse_seconds: z.number().int().positive(), children_cap: z.number().int().positive(), mission: z.string().min(1) }).optional(),
  } }, async (input) => {
    // A parentless caller is a human-launched root session (Raphaël's own Lead/Capitaine), always trusted to
    // bootstrap a manager; an MCP-spawned child needs the manager role itself — see Task 7 report deviation.
    const isRootSession = caller.parentId === undefined;
    const canCreateManager = isRootSession || caller.role === MANAGER_ROLE;
    if (input.manager && !canCreateManager) return fail('only an existing manager may create another manager');

    const isWithinWorktreesRoot = isPathWithin(input.directory, deps.worktreesRoot);
    const isCallersOwnRepo = await sameGitRepository(caller.directory, input.directory);
    if (!isWithinWorktreesRoot && !isCallersOwnRepo) return fail('directory must be inside the worktrees root or inside your own git repository');

    if (caller.role === MANAGER_ROLE) {
      const record = managers.get(caller.id);
      // Synchronous check against a synchronous DB read, with no `await` between here and the insert
      // inside sessions.create()/managers.createManagerSession() below: Node never interleaves another
      // callback into this handler before that insert happens, so two concurrent create_session calls
      // can never both pass this check before either session exists — see Review Focus #3.
      const activeChildren = sessions.list().filter((s) => s.parentId === caller.id && s.state !== 'closed').length;
      if (record && activeChildren >= record.childrenCap) return fail(`children cap reached (${activeChildren}/${record.childrenCap})`);
    }

    const resolvedModel = input.model ? resolveModel(modelTable, input.model) : undefined;
    // Any MCP-originated create_session call comes from an orchestrating session (parentId is always
    // set), so its children default to the gated permission mode unless the caller overrides it —
    // phase 1 deviation #11(a): otherwise `auto`-mode callers never see a PermissionRequest at all.
    // Amendment A1: the gated default is 'manual', never 'default' — PERMISSION_MODES no longer accepts it.
    const permissionMode = input.permission_mode ?? 'manual';

    const spec = {
      directory: input.directory, name: input.name, emoji: input.emoji ?? '🤖', model: resolvedModel,
      seededPrompt: input.seeded_prompt, role: input.role, parentId: caller.id, harness: caller.harness, permissionMode,
    };

    const child = input.manager
      ? await managers.createManagerSession({ ...spec, role: MANAGER_ROLE, manager: { pulseSeconds: input.manager.pulse_seconds, childrenCap: input.manager.children_cap, mission: input.manager.mission } as ManagerSpec })
      : await sessions.create(spec);
    return ok(child);
  });

  server.registerTool('update_session', { description: "Change the model of yourself or one of your children (a rung name like 'opus' or an exact model id)", inputSchema: { session_id: z.string().optional(), model: z.string().min(1) } }, async ({ session_id, model }) => {
    const targetId = session_id ?? caller.id;
    if (targetId !== caller.id) {
      const target = sessions.get(targetId);
      if (!target || target.parentId !== caller.id) return fail('you can only update yourself or your own child');
    }
    return ok(sessions.updateModel(targetId, resolveModel(modelTable, model)));
  });

  server.registerTool('get_argus_status', { description: 'Your manager record (if any) and each child: state, pending permission, queued messages', inputSchema: {} }, async () => {
    const children = sessions.list().filter((s) => s.parentId === caller.id).map((child) => ({
      id: child.id, name: child.name, emoji: child.emoji, state: child.state, stateSince: child.stateSince,
      pendingPermission: pendingPermissionFor(child.id),
      queuedMessageCount: sessions.queuedMessageCount(child.id),
    }));
    const record = caller.role === MANAGER_ROLE ? managers.get(caller.id) : undefined;
    const manager = record ? toManagerView(record, children.filter((c) => c.state !== 'closed').length) : null;
    return ok({ manager, children });
  });

  server.registerTool('pulse_now', { description: 'Trigger an immediate pulse for a manager (yourself, or a manager you are the parent of)', inputSchema: { session_id: z.string().optional() } }, async ({ session_id }) => {
    const targetId = session_id ?? caller.id;
    const target = sessions.get(targetId);
    if (!target || !isInLineage(target) || target.role !== MANAGER_ROLE) return fail('target is not a manager in your lineage');
    const record = pulseScheduler.pulseNow(targetId);
    if (!record) return fail('manager record not found');
    return ok({ pulsed: true });
  });

  server.registerTool('close_session', { description: 'Close one of your children', inputSchema: { session_id: z.string() } }, async ({ session_id }) => {
    const target = sessions.get(session_id);
    if (!target || target.parentId !== caller.id) return fail('not your child');
    await sessions.close(target.id);
    return ok({ closed: target.id });
  });
}
