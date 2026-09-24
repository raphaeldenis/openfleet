import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Session } from '@openfleet/shared';
import { z } from 'zod';
import { createWorktree } from '../git/worktrees.js';
import type { SessionService } from '../sessions/sessionService.js';

const ok = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

export function registerTools(server: McpServer, deps: { sessions: SessionService; caller: Session; worktreesRoot: string }): void {
  const { sessions, caller } = deps;
  const isInLineage = (target: Session) => target.id === caller.id || target.parentId === caller.id || target.id === caller.parentId;

  server.registerTool('get_session_status', { description: 'State of your session or one in your lineage', inputSchema: { session_id: z.string().optional() } }, async ({ session_id }) => {
    const target = sessions.get(session_id ?? caller.id);
    if (!target || !isInLineage(target)) return fail('session not found or outside your lineage');
    return ok(target);
  });

  server.registerTool('list_children', { description: 'Sessions you spawned', inputSchema: {} }, async () => ok(sessions.list().filter((s) => s.parentId === caller.id)));

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
      return ok(await createWorktree({ repoPath: repo_path, branchName: branch_name, worktreesRoot: deps.worktreesRoot }));
    } catch (error) {
      return fail((error as Error).message);
    }
  });

  server.registerTool('create_session', { description: 'Spawn a child coding session in a directory (use create_worktree first)', inputSchema: {
    directory: z.string(), name: z.string().min(1), emoji: z.string().optional(), model: z.string().optional(), seeded_prompt: z.string().optional(), role: z.string().optional(),
  } }, async (input) => {
    const child = await sessions.create({ directory: input.directory, name: input.name, emoji: input.emoji ?? '🤖', model: input.model, seededPrompt: input.seeded_prompt, role: input.role, parentId: caller.id, harness: caller.harness });
    return ok(child);
  });

  server.registerTool('close_session', { description: 'Close one of your children', inputSchema: { session_id: z.string() } }, async ({ session_id }) => {
    const target = sessions.get(session_id);
    if (!target || target.parentId !== caller.id) return fail('not your child');
    await sessions.close(target.id);
    return ok({ closed: target.id });
  });
}
