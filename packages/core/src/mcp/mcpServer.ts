import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { OpenFleetError, type Session } from '@openfleet/shared';
import type { ApprovalService } from '../governance/approvalService.js';
import type { ManagerService } from '../managers/managerService.js';
import type { PulseScheduler } from '../managers/pulseScheduler.js';
import type { ModelTable } from '../models.js';
import type { DocsFolderService } from '../notes/docsFolderService.js';
import type { NoteRepository } from '../notes/noteRepository.js';
import type { NoteService } from '../notes/noteService.js';
import type { ProjectRepository } from '../projects/projectRepository.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { DataStoreRepository } from '../stores/dataStoreRepository.js';
import type { DataStoreService } from '../stores/dataStoreService.js';
import { DAEMON_VERSION } from '../version.js';
import type { WorkingStateService } from '../workingState/workingStateService.js';
import { registerNoteTools } from './noteTools.js';
import { registerNoteVersionTools } from './noteVersionTools.js';
import { registerProjectTools } from './projectTools.js';
import { registerTableTools } from './tableTools.js';
import { registerTableViewTools } from './tableViewTools.js';
import { catchingToolErrors } from './toolResults.js';
import { registerTools } from './tools.js';
import { registerWorkingStateTools } from './workingStateTools.js';

/** A view of the server whose every registered handler answers a throw in the error grammar, so nothing reaches the SDK's own error text. */
function answeringThrowsInGrammar(server: McpServer, caller: Session): McpServer {
  const catching = catchingToolErrors(caller);
  const registerToolCatching = (name: string, config: unknown, handler: (...args: unknown[]) => unknown) =>
    (server.registerTool as (...args: unknown[]) => unknown).call(server, name, config, catching(handler));
  return new Proxy(server, {
    get: (target, property) => (property === 'registerTool' ? registerToolCatching : Reflect.get(target, property, target)),
  });
}

export function createMcpHandler(deps: { sessions: SessionService; approvals: ApprovalService; managers: ManagerService; pulseScheduler: PulseScheduler; modelTable: ModelTable; stores: DataStoreService; storeRepo: DataStoreRepository; notes: NoteService; noteRepo: NoteRepository; docs: DocsFolderService; projects: ProjectRepository; workingStates: WorkingStateService; worktreesRoot: string }) {
  return async (req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const caller = deps.sessions.byMcpToken(token);
    if (!caller) throw new OpenFleetError('unauthorized', 'the mcp token is missing or wrong.');

    // ponytail: one McpServer per request (stateless); pool them if profiling says so
    const server = new McpServer({ name: 'openfleet', version: DAEMON_VERSION });
    const toolServer = answeringThrowsInGrammar(server, caller);
    registerTools(toolServer, { ...deps, caller });
    registerTableTools(toolServer, { stores: deps.stores, storeRepo: deps.storeRepo, caller });
    registerTableViewTools(toolServer, { stores: deps.stores, storeRepo: deps.storeRepo, caller });
    registerNoteTools(toolServer, { notes: deps.notes, noteRepo: deps.noteRepo, docs: deps.docs, caller });
    registerNoteVersionTools(toolServer, { notes: deps.notes, noteRepo: deps.noteRepo, docs: deps.docs, caller });
    registerProjectTools(toolServer, { projects: deps.projects, noteRepo: deps.noteRepo, caller });
    registerWorkingStateTools(toolServer, { workingStates: deps.workingStates, sessions: deps.sessions, caller });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
