import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { OpenFleetError, contractVersionInstructions, type Session } from '@openfleet/shared';
import type { ApprovalService } from '../governance/approvalService.js';
import type { BaseNotReadEnforcement } from '../managers/baseReadGuard.js';
import type { NoteNotReadEnforcement } from '../managers/noteReadGuard.js';
import type { ManagerBase } from '../managers/managerBase.js';
import type { ManagerService } from '../managers/managerService.js';
import type { PulseScheduler } from '../managers/pulseScheduler.js';
import type { ModelTable } from '../models.js';
import type { DocsFolderService } from '../notes/docsFolderService.js';
import type { NoteRepository } from '../notes/noteRepository.js';
import type { NoteService } from '../notes/noteService.js';
import type { ProjectRepository } from '../projects/projectRepository.js';
import type { ReviewFindingsRepository } from '../review/reviewFindingsRepository.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { DataStoreRepository } from '../stores/dataStoreRepository.js';
import type { DataStoreService } from '../stores/dataStoreService.js';
import { DAEMON_VERSION } from '../version.js';
import type { WorkingStateService } from '../workingState/workingStateService.js';
import type { GovernanceQueueService } from '../governance/governanceQueueService.js';
import type { ManagerDenials } from '../policy/managerDenials.js';
import type { DenialJournal } from '../policy/ports.js';
import { registerDeniedCommandTools } from './deniedCommandTools.js';
import { registerGovernanceTools } from './governanceTools.js';
import { registerManagerBaseTools } from './managerBaseTools.js';
import { registerManagerLinkTools } from './managerLinkTools.js';
import { registerManagerProfileTools } from './managerProfileTools.js';
import { registerNoteTools } from './noteTools.js';
import { registerKnowledgeTools, type KnowledgeToolSearchPort } from './knowledgeTools.js';
import { registerNoteVersionTools } from './noteVersionTools.js';
import { registerProjectProfileTools } from './projectProfileTools.js';
import { registerProjectTools } from './projectTools.js';
import type { ProjectProfileBootstrap } from '../managers/projectProfileBootstrap.js';
import { REVIEWER_ROLE, registerShipVerdictTools } from './shipVerdictTools.js';
import { registerStepFindingTools } from './stepFindingTools.js';
import { registerTableTools } from './tableTools.js';
import { registerTableViewTools } from './tableViewTools.js';
import { catchingToolErrors } from './toolResults.js';
import { registerTools } from './tools.js';
import { registerWorkingStateTools } from './workingStateTools.js';
import { registerWorktreeTools } from './worktreeTools.js';
import { WorktreeService } from '../worktrees/worktreeService.js';

/** The only tools a reviewer sees: it reports to its manager and writes nothing else. */
const REVIEWER_TOOL_NAMES: ReadonlySet<string> = new Set(['report_ship_verdict', 'message_parent']);

/** A view of the server that registers only the tools allowed; every other registration is skipped. */
function registeringOnly(server: McpServer, allowedToolNames: ReadonlySet<string>): McpServer {
  const registerAllowedTool = (name: string, ...rest: unknown[]) =>
    allowedToolNames.has(name) ? (server.registerTool as (...args: unknown[]) => unknown).call(server, name, ...rest) : undefined;
  return new Proxy(server, {
    get: (target, property) => (property === 'registerTool' ? registerAllowedTool : Reflect.get(target, property, target)),
  });
}

/** A view of the server whose every registered handler answers a throw in the error grammar, so nothing reaches the SDK's own error text. */
function answeringThrowsInGrammar(server: McpServer, caller: Session): McpServer {
  const catching = catchingToolErrors(caller);
  const registerToolCatching = (name: string, config: unknown, handler: (...args: unknown[]) => unknown) =>
    (server.registerTool as (...args: unknown[]) => unknown).call(server, name, config, catching(handler));
  return new Proxy(server, {
    get: (target, property) => (property === 'registerTool' ? registerToolCatching : Reflect.get(target, property, target)),
  });
}

export function createMcpHandler(deps: { projectProfile?: ProjectProfileBootstrap; reviewFindings?: ReviewFindingsRepository; ticketPattern?: string;managerBase?: ManagerBase; baseNotReadEnforcement?: BaseNotReadEnforcement; noteNotReadEnforcement?: NoteNotReadEnforcement; denialJournal?: DenialJournal; managerDenials?: ManagerDenials;knowledgeSearch: KnowledgeToolSearchPort; governanceQueue: GovernanceQueueService; sessions: SessionService; approvals: ApprovalService; managers: ManagerService; pulseScheduler: PulseScheduler; modelTable: ModelTable; stores: DataStoreService; storeRepo: DataStoreRepository; notes: NoteService; noteRepo: NoteRepository; docs: DocsFolderService; projects: ProjectRepository; workingStates: WorkingStateService; worktreesRoot: string; homeDirectory?: string }) {
  return async (req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const caller = deps.sessions.byMcpToken(token);
    if (!caller) throw new OpenFleetError('unauthorized', 'the mcp token is missing or wrong.');

    // ponytail: one McpServer per request (stateless); pool them if profiling says so
    const server = new McpServer({ name: 'openfleet', version: DAEMON_VERSION }, { instructions: contractVersionInstructions() });
    const answeringServer = answeringThrowsInGrammar(server, caller);
    const isReviewer = caller.role === REVIEWER_ROLE;
    const toolServer = isReviewer ? registeringOnly(answeringServer, REVIEWER_TOOL_NAMES) : answeringServer;
    registerTools(toolServer, { ...deps, caller });
    if (deps.reviewFindings) registerShipVerdictTools(toolServer, { reviewFindings: deps.reviewFindings, managers: deps.managers, sessions: deps.sessions, caller, ...(deps.ticketPattern === undefined ? {} : { ticketPattern: deps.ticketPattern }) });
    if (deps.reviewFindings) registerStepFindingTools(toolServer, { reviewFindings: deps.reviewFindings, managers: deps.managers, caller, ...(deps.ticketPattern === undefined ? {} : { ticketPattern: deps.ticketPattern }) });
    registerManagerLinkTools(toolServer, { managers: deps.managers, caller });
    registerManagerProfileTools(toolServer, { managers: deps.managers, caller });
    if (deps.projectProfile) registerProjectProfileTools(toolServer, { projectProfile: deps.projectProfile, managers: deps.managers, sessions: deps.sessions, caller });
    if (deps.managerBase) registerManagerBaseTools(toolServer, { managerBase: deps.managerBase, managers: deps.managers, caller });
    if (deps.managerDenials) registerDeniedCommandTools(toolServer, { managerDenials: deps.managerDenials, sessions: deps.sessions, caller });
    registerGovernanceTools(toolServer, { governanceQueue: deps.governanceQueue, caller });
    registerKnowledgeTools(toolServer, { knowledgeSearch: deps.knowledgeSearch, caller });
    registerTableTools(toolServer, { stores: deps.stores, storeRepo: deps.storeRepo, caller });
    registerTableViewTools(toolServer, { stores: deps.stores, storeRepo: deps.storeRepo, caller });
    const noteToolDeps = { notes: deps.notes, noteRepo: deps.noteRepo, docs: deps.docs, caller, isMissionNote: (noteId: string) => deps.managers.isMissionNote(noteId) };
    const missionNoteReadingDeps = { ...noteToolDeps, onNoteRead: ({ noteId, noteRev, response }: { noteId: string; noteRev: number; response: object }) =>
      deps.managers.recordNoteRead({ sessionId: caller.id, noteId, noteRev, response: response as Record<string, unknown> }) };
    registerNoteTools(toolServer, missionNoteReadingDeps);
    registerNoteVersionTools(toolServer, noteToolDeps);
    registerProjectTools(toolServer, { projects: deps.projects, noteRepo: deps.noteRepo, caller });
    registerWorktreeTools(toolServer, { worktrees: new WorktreeService({ projects: deps.projects, sessions: deps.sessions, worktreesRoot: deps.worktreesRoot }), caller });
    registerWorkingStateTools(toolServer, { workingStates: deps.workingStates, sessions: deps.sessions, caller });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
