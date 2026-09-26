import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { json } from '../api/router.js';
import type { ApprovalService } from '../governance/approvalService.js';
import type { ManagerService } from '../managers/managerService.js';
import type { PulseScheduler } from '../managers/pulseScheduler.js';
import type { ModelTable } from '../models.js';
import type { SessionService } from '../sessions/sessionService.js';
import { registerTools } from './tools.js';

export function createMcpHandler(deps: { sessions: SessionService; approvals: ApprovalService; managers: ManagerService; pulseScheduler: PulseScheduler; modelTable: ModelTable; worktreesRoot?: string }) {
  return async (req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const caller = deps.sessions.byMcpToken(token);
    if (!caller) return json(res, 401, { error: 'unauthorized' });

    // ponytail: one McpServer per request (stateless); pool them if profiling says so
    const server = new McpServer({ name: 'openfleet', version: '0.1.0' });
    registerTools(server, { ...deps, caller, worktreesRoot: deps.worktreesRoot ?? '/tmp/openfleet-worktrees' });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
