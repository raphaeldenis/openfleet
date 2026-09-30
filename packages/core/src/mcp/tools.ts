import { MANAGER_ROLE, ManagerSpecSchema, ModelIdSchema, PERMISSION_MODES, type Approval, type ManagerSpec, type Session } from '@openfleet/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { z } from 'zod';
import { createWorktree, isPathWithin, sameGitRepository } from '../git/worktrees.js';
import { resolveModel, type ModelTable } from '../models.js';
import type { ApprovalService } from '../governance/approvalService.js';
import type { ManagerService } from '../managers/managerService.js';
import { toManagerView } from '../managers/managerView.js';
import type { PulseScheduler } from '../managers/pulseScheduler.js';
import { lineageSessionView, managerView, sessionView } from './toolViews.js';
import { SessionClosedError, TooManyPendingMessagesError, type SessionService } from '../sessions/sessionService.js';

const ok = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

// No longer a pty-write constraint (Task 6h moved delivery to bracketed-paste typing, which handles
// arbitrarily long bodies) — this is a sane upper bound for agent-to-agent messages, matching the cap
// Scape applies to the same tools.
const MAX_MESSAGE_BODY_BYTES = 8192;
function tooLongMessage(body: string): string | undefined {
  const byteLength = Buffer.byteLength(body, 'utf8');
  return byteLength > MAX_MESSAGE_BODY_BYTES ? `message too long: ${byteLength} bytes, max ${MAX_MESSAGE_BODY_BYTES}` : undefined;
}

// Shared by send_session_message and message_parent: both just pick a different target session for the
// same delivery call and need the same closed-target and pending-limit tool errors. Any other thrown error (e.g. a colliding
// message_id) is left to propagate — the MCP SDK turns it into isError itself.
function trySendMessage(send: () => { status: 'delivered' | 'queued'; messageId: string }) {
  try {
    const result = send();
    return ok({ status: result.status, message_id: result.messageId });
  } catch (error) {
    if (error instanceof TooManyPendingMessagesError) return fail(error.message);
    if (!(error instanceof SessionClosedError)) throw error;
    return fail('target session is closed');
  }
}

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
  const realPathOrSelf = (directory: string) => (existsSync(directory) ? realpathSync.native(directory) : directory);
  const isSameDirectory = (first: string, second: string): boolean => {
    if (first === second) return true;
    try {
      const firstStat = statSync(first);
      const secondStat = statSync(second);
      return firstStat.dev === secondStat.dev && firstStat.ino === secondStat.ino;
    } catch {
      return false;
    }
  };
  const isSessionDirectory = (session: Session, realDirectory: string): boolean => {
    const recordedRealpath = sessions.directoryRealpathOf(session.id);
    const isRecordedDirectory = recordedRealpath ? isSameDirectory(recordedRealpath, realDirectory) : false;
    return isRecordedDirectory || isSameDirectory(realPathOrSelf(session.directory), realDirectory);
  };
  const findLineageSessionOwning = (realDirectory: string): Session | undefined => {
    const visited = new Set<string>();
    for (let session: Session | undefined = caller; session && !visited.has(session.id); session = session.parentId ? sessions.get(session.parentId) : undefined) {
      visited.add(session.id);
      if (isSessionDirectory(session, realDirectory)) return session;
    }
    return undefined;
  };
  const comparableName = (name: string) => name.trim().normalize('NFC');
  const findLiveChildDuplicating = (input: { name: string; realDirectory: string }): { child: Session; sameAs: 'name' | 'directory' } | undefined => {
    const requestedName = comparableName(input.name);
    for (const child of sessions.list()) {
      const isLiveChildOfCaller = child.parentId === caller.id && child.state !== 'closed';
      if (!isLiveChildOfCaller) continue;
      if (comparableName(child.name) === requestedName) return { child, sameAs: 'name' };
      if (isSessionDirectory(child, input.realDirectory)) return { child, sameAs: 'directory' };
    }
    return undefined;
  };
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
    return ok(sessionView(target));
  });

  server.registerTool('list_children', { description: 'Sessions you spawned', inputSchema: {} }, async () => ok(sessions.list().filter((s) => s.parentId === caller.id).map(sessionView)));

  server.registerTool('list_sessions', { description: 'You, your children, and every descendant beneath them', inputSchema: {} }, async () =>
    ok(sessions.list().filter((s) => s.id === caller.id || isDescendant(s)).map(lineageSessionView)),
  );

  server.registerTool('send_session_message', { description: 'Send a message to a child (or your parent). Queued if it is busy, delivered on its next idle turn. Pass back a previous message_id to retry idempotently.', inputSchema: { target_uuid: z.string(), body: z.string().min(1), message_id: z.uuid().optional() } }, async ({ target_uuid, body, message_id }) => {
    const tooLong = tooLongMessage(body);
    if (tooLong) return fail(tooLong);
    const target = sessions.get(target_uuid);
    if (!target || !isInLineage(target) || target.id === caller.id) return fail('target not found or outside your lineage');
    return trySendMessage(() => sessions.sendMessage({ sessionId: target.id, body, fromSessionId: caller.id, messageId: message_id }));
  });

  server.registerTool('message_parent', { description: 'Report to the manager that spawned you. Pass back a previous message_id to retry idempotently.', inputSchema: { body: z.string().min(1), message_id: z.uuid().optional() } }, async ({ body, message_id }) => {
    const tooLong = tooLongMessage(body);
    if (tooLong) return fail(tooLong);
    if (!caller.parentId) return fail('this session has no parent');
    return trySendMessage(() => sessions.sendMessage({ sessionId: caller.parentId!, body, fromSessionId: caller.id, messageId: message_id }));
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
    directory: z.string(), name: z.string().refine((name) => name.trim().length > 0, 'name must not be blank'), emoji: z.string().optional(), model: ModelIdSchema.optional(),
    seeded_prompt: z.string().optional(), role: z.string().optional(), permission_mode: z.enum(PERMISSION_MODES).optional(),
    allow_duplicate: z.boolean().optional(),
    manager: z.object({ pulse_seconds: ManagerSpecSchema.shape.pulseSeconds, children_cap: z.number().int().positive(), mission: z.string().min(1) }).optional(),
  } }, async (input) => {
    // A parentless caller is a human-launched root session (Raphaël's own Lead/Capitaine), always trusted to
    // bootstrap a manager; an MCP-spawned child needs the manager role itself — see Task 7 report deviation.
    const isRootSession = caller.parentId === undefined;
    // The same trust boundary gates both spawning a manager and overriding the gated default permission
    // mode: a plain MCP-spawned child gets neither privilege.
    const isTrustedOrchestrator = isRootSession || caller.role === MANAGER_ROLE;
    const resolvedTargetRole = input.manager ? MANAGER_ROLE : input.role;
    if (resolvedTargetRole === MANAGER_ROLE && !input.manager) return fail('role "manager" requires a manager spec');
    if (input.manager && !isTrustedOrchestrator) return fail('only an existing manager may create another manager');

    if (input.permission_mode !== undefined) {
      if (!isTrustedOrchestrator) return fail('only a manager or a root session may set permission_mode; a plain caller\'s children always get manual');
      if (input.permission_mode === 'bypassPermissions') return fail('bypassPermissions cannot be set through MCP');
    }

    // The directory must already exist: without this, a symlinked "..' segment could be lexically
    // collapsed back inside the root by path.resolve() while the OS actually opened somewhere else, and
    // a genuinely missing directory used to reach the harness, which then died with exit 1 instead of
    // failing this tool call cleanly.
    if (!existsSync(input.directory)) return fail(`directory does not exist: ${input.directory}`);
    // realpathSync.native, not the plain (non-native) realpathSync: Node's own JS reimplementation has a
    // lexical blind spot for some symlink + ".." combinations that the native OS call does not.
    const realDirectory = realpathSync.native(input.directory);

    const ownerOfRequestedDirectory = findLineageSessionOwning(realDirectory);
    if (ownerOfRequestedDirectory) {
      return fail(`directory ${realDirectory} is already the working directory of session ${ownerOfRequestedDirectory.id} (${ownerOfRequestedDirectory.name}), which is you or one of your ancestors: use a worktree (create_worktree) or another directory`);
    }

    // ponytail: a task is identified by the child's name or directory, not by a task id; a manager that
    // renames its children defeats the guard. Upgrade path: a `task` field matched against the backlog row.
    const refuseLiveDuplicate = () => {
      const liveDuplicate = input.allow_duplicate ? undefined : findLiveChildDuplicating({ name: input.name, realDirectory });
      if (!liveDuplicate) return undefined;
      const { child, sameAs } = liveDuplicate;
      return fail(`session ${child.id} (${child.name}) is already a live child of yours (state ${child.state}) with the same ${sameAs}: message it with send_session_message instead of spawning again, close_session ${child.id} if it is stuck or dead and spawn again, or pass allow_duplicate: true if two sessions are intended`);
    };
    const earlyDuplicateRefusal = refuseLiveDuplicate();
    if (earlyDuplicateRefusal) return earlyDuplicateRefusal;

    const isWithinWorktreesRoot = isPathWithin(realDirectory, deps.worktreesRoot);
    const isCallersOwnRepo = await sameGitRepository(caller.directory, realDirectory);
    if (!isWithinWorktreesRoot && !isCallersOwnRepo) return fail('directory must be inside the worktrees root or inside your own git repository');

    const isDirectoryUnchangedSinceChecks = existsSync(input.directory) && realpathSync.native(input.directory) === realDirectory;
    if (!isDirectoryUnchangedSinceChecks) return fail(`directory ${input.directory} changed while the spawn was being checked: retry`);

    // No `await` between this re-check and the insert in sessions.create(): a concurrent create_session
    // that passed the early check while this one awaited sameGitRepository is refused here.
    const isCallerStillLive = sessions.get(caller.id)?.state !== 'closed';
    if (!isCallerStillLive) return fail(`your session ${caller.id} is no longer live: it was closed while the spawn was being checked, so no child is created`);

    const lateDuplicateRefusal = refuseLiveDuplicate();
    if (lateDuplicateRefusal) return lateDuplicateRefusal;

    if (caller.role === MANAGER_ROLE) {
      const record = managers.get(caller.id);
      // Synchronous check against a synchronous DB read, with no `await` between here and the insert
      // inside sessions.create()/managers.createManagerSession() below: Node never interleaves another
      // callback into this handler before that insert happens, so two concurrent create_session calls
      // can never both pass this check before either session exists — see Review Focus #3.
      const activeChildren = sessions.list().filter((s) => s.parentId === caller.id && s.state !== 'closed').length;
      // A manager-role caller with no ManagerRecord (legacy data, a role forged before this guard existed,
      // a deleted record) is capped at 0 rather than treated as unlimited — defence in depth.
      const childrenCap = record ? record.childrenCap : 0;
      if (activeChildren >= childrenCap) return fail(`children cap reached (${activeChildren}/${childrenCap})`);
    }

    const resolvedModel = input.model ? resolveModel(modelTable, input.model) : undefined;
    // Any MCP-originated create_session call comes from an orchestrating session (parentId is always
    // set), so its children default to the gated permission mode unless the caller overrides it —
    // phase 1 deviation #11(a): otherwise `auto`-mode callers never see a PermissionRequest at all.
    // Amendment A1: the gated default is 'manual', never 'default' — PERMISSION_MODES no longer accepts it.
    const permissionMode = input.permission_mode ?? 'manual';

    const spec = {
      directory: realDirectory, name: input.name, emoji: input.emoji ?? '🤖', model: resolvedModel,
      seededPrompt: input.seeded_prompt, role: input.role, parentId: caller.id, harness: caller.harness, permissionMode,
    };

    const child = input.manager
      ? await managers.createManagerSession({ ...spec, role: MANAGER_ROLE, manager: { pulseSeconds: input.manager.pulse_seconds, childrenCap: input.manager.children_cap, mission: input.manager.mission } as ManagerSpec })
      : await sessions.create(spec);
    return ok(sessionView(child));
  });

  server.registerTool('update_session', { description: "Change the model of yourself or one of your children (a rung name like 'opus' or an exact model id)", inputSchema: { session_id: z.string().optional(), model: ModelIdSchema } }, async ({ session_id, model }) => {
    const targetId = session_id ?? caller.id;
    if (targetId !== caller.id) {
      const target = sessions.get(targetId);
      if (!target || target.parentId !== caller.id) return fail('you can only update yourself or your own child');
    }
    return ok(sessions.updateModel(targetId, resolveModel(modelTable, model)));
  });

  server.registerTool('get_argus_status', { description: 'Your manager record (if any) and each child: state, pending permission, queued messages', inputSchema: {} }, async () => {
    const children = sessions.list().filter((s) => s.parentId === caller.id).map((child) => ({
      id: child.id, name: child.name, state: child.state, stateSince: child.stateSince,
      pendingPermission: pendingPermissionFor(child.id),
      queuedMessageCount: sessions.queuedMessageCount(child.id),
    }));
    const record = caller.role === MANAGER_ROLE ? managers.get(caller.id) : undefined;
    const manager = record ? managerView(toManagerView(record, children.filter((c) => c.state !== 'closed').length)) : null;
    return ok({ manager, children });
  });

  server.registerTool('pulse_now', { description: 'Trigger an immediate pulse for a manager (yourself, or a manager you are the parent of)', inputSchema: { session_id: z.string().optional() } }, async ({ session_id }) => {
    const targetId = session_id ?? caller.id;
    const target = sessions.get(targetId);
    // Narrower than isInLineage: a manager may pulse itself or a manager it is the direct parent of, but
    // never its own parent — pulsing your manager is not "yours to trigger" even though you can message it.
    const isSelfOrOwnManagedChild = target !== undefined && (target.id === caller.id || target.parentId === caller.id);
    if (!target || !isSelfOrOwnManagedChild || target.role !== MANAGER_ROLE) return fail('target is not a manager in your lineage');
    const record = pulseScheduler.pulseNow(targetId);
    if (!record) return fail('manager record not found');
    return ok({ pulsed: true });
  });

  server.registerTool('close_session', { description: 'Close one of your children', inputSchema: { session_id: z.string() } }, async ({ session_id }) => {
    const target = sessions.get(session_id);
    if (!target || target.parentId !== caller.id) return fail('not your child');
    await sessions.close(target.id, { closedByParent: true });
    return ok({ closed: target.id });
  });
}
