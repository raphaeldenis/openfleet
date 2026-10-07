import { join } from 'node:path';
import { createHandoffRouteDeps } from './api/handoffRoutes.js';
import { startServer } from './api/server.js';
import type { Config } from './config.js';
import { readingConfigFile } from './configFileError.js';
import { openDatabase } from './db/database.js';
import { buildDiagnosticsDocument } from './diagnostics/diagnosticsDocument.js';
import { describeError } from './errors/describeError.js';
import { EventBus } from './events/eventBus.js';
import { ApprovalService } from './governance/approvalService.js';
import { loadPermissionSettings } from './governance/permissionSettings.js';
import { SilentBlockDetector } from './governance/silentBlockDetector.js';
import { ClaudeCliHarness } from './harness/claudeCli/claudeCliHarness.js';
import { sweepStaleSessions } from './harness/claudeCli/tokenFiles.js';
import { FakeHarness, postSessionStartHook } from './harness/fakeHarness.js';
import { newId } from './ids.js';
import { createNodeGitPort } from './git/nodeGitPort.js';
import { log } from './logger.js';
import { CaffeinatePowerApi } from './power/caffeinatePowerApi.js';
import type { PowerApi } from './power/powerApi.js';
import { loadPowerSettings } from './power/powerSettings.js';
import { SleepGuard } from './power/sleepGuard.js';
import { DAEMON_VERSION } from './version.js';
import { scapeImportStatusOfManager } from './import/scape/scapeManagerEditStatus.js';
import { ManagerRepository } from './managers/managerRepository.js';
import { ManagerService } from './managers/managerService.js';
import { PulseScheduler } from './managers/pulseScheduler.js';
import { createMcpHandler } from './mcp/mcpServer.js';
import { loadModelTable } from './models.js';
import { DocsFolderService } from './notes/docsFolderService.js';
import { registerHandoffOnClose } from './notes/handoffService.js';
import { loadHandoffSettings } from './notes/handoffSettings.js';
import { expandMentions } from './notes/mentionExpander.js';
import { nodeDocsFolderFs } from './notes/nodeDocsFolderFs.js';
import { NoteRepository } from './notes/noteRepository.js';
import { NoteService } from './notes/noteService.js';
import { closeWithin } from './process/boundedClose.js';
import { createDegradedRegistry, type DegradedRegistry } from './process/degradedRegistry.js';
import { watchDatabaseHealth } from './process/watchDatabaseHealth.js';
import { DocsFolderSupervisor } from './projects/docsFolderSupervisor.js';
import { ProjectRepository } from './projects/projectRepository.js';
import { ProjectService } from './projects/projectService.js';
import { SessionService } from './sessions/sessionService.js';
import { DataStoreRepository } from './stores/dataStoreRepository.js';
import { DataStoreService } from './stores/dataStoreService.js';
import { TodoTracker } from './todos/todoTracker.js';
import { ContextNotice } from './workingState/contextNotice.js';
import { HandoverLedger } from './workingState/handoverLedger.js';
import { SessionStartContext } from './workingState/sessionStartContext.js';
import { StopRefusal } from './workingState/stopRefusal.js';
import { WorkingStateService } from './workingState/workingStateService.js';
import { loadDaemonSettings } from './workingState/workingStateSettings.js';

const REFUSED_BOOT_CLOSE_TIMEOUT_MS = 5000;
const ISSUE_EXPIRY_SWEEP_MS = 30_000;

// An unref'd timer never keeps the daemon alive on its own.
const scheduleOnRealClock = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
};

// The line names the project and the step, never the folder: an error message can carry a path.
const logDocsFolderFailure = (step: string, projectId?: string) => (error: unknown): void => {
  const errorCode = (error as NodeJS.ErrnoException | undefined)?.code ?? (error as Error | undefined)?.name;
  const project = projectId ? ` for project ${projectId}` : '';
  log('warn', `docs folder ${step} failed${project}`, undefined, { code: 'docs_folder_step_failed', step, errorCode });
};

export interface Daemon {
  server: Awaited<ReturnType<typeof startServer>>;
  db: ReturnType<typeof openDatabase>;
  degraded: DegradedRegistry;
  close: () => Promise<void>;
}

export interface DaemonOptions {
  /** The registry the process guards already mark; the daemon makes its own when none is handed over. */
  degraded?: DegradedRegistry;
  claudeConfigPath?: string;
  power?: {
    api?: PowerApi;
    clock?: () => number;
    schedule?: (callback: () => void, delayMs: number) => () => void;
  };
}

// Builds every service from the config and starts serving; a throw at any point refuses the boot, after closing whatever already started.
// `claudeConfigPath` redirects the folder trust writes of the claude CLI harness; the default is the user's ~/.claude.json.
export async function startDaemon(config: Config, options: DaemonOptions = {}): Promise<Daemon> {
  const { degraded = createDegradedRegistry() } = options;
  const db = openDatabase(config.dbPath);
  const bus = new EventBus();
  const baseUrl = `http://${config.host}:${config.port}`;
  const claudeCliHarness = new ClaudeCliHarness(config.sessionsRoot, process.env, options.claudeConfigPath);
  const harnesses = config.e2eEnabled ? [claudeCliHarness, new FakeHarness({ reportSessionStart: postSessionStartHook })] : [claudeCliHarness];
  if (config.e2eEnabled) log('warn', 'e2e test surface enabled (OPENFLEET_E2E=1): fake harness and fake-output route are registered');
  const managerRepository = new ManagerRepository(db);
  const sessions = new SessionService({ db, bus, harnesses, baseUrl, worktreesRoot: config.worktreesRoot, describeError, missionOf: (sessionId) => managerRepository.get(sessionId)?.missionText });
  const approvals = new ApprovalService({ db, bus });
  // A row still 'pending' from before this boot has no live waiter any more (AUD-07): the pre-restart
  // process that would have decided it is gone with the old daemon.
  approvals.expireAllPending('daemon restarted');
  const modelConfigPath = join(config.home, 'config.json');
  const modelTable = readingConfigFile(() => loadModelTable(modelConfigPath));
  const { workingState: workingStateSettings, managers: managerSettings, contextNotice: contextNoticeSettings } = readingConfigFile(() => loadDaemonSettings(modelConfigPath));
  const powerSettings = readingConfigFile(() => loadPowerSettings(modelConfigPath));
  const powerApi = options.power?.api ?? new CaffeinatePowerApi();
  const supportsPowerAssertions = options.power?.api !== undefined || process.platform === 'darwin';
  const sleepGuard = new SleepGuard({ sessions, bus, power: powerApi,
    enabled: supportsPowerAssertions && powerSettings.preventIdleSleepWhileGenerating,
    clock: options.power?.clock ?? Date.now, schedule: options.power?.schedule ?? scheduleOnRealClock,
    onPowerUnavailable: () => degraded.mark('power_assertion_unavailable', 'Idle sleep protection is unavailable while sessions generate.'),
    onPowerAvailable: () => degraded.clear('power_assertion_unavailable'),
  });
  sleepGuard.observeSessionEvents();
  const pulseScheduler = new PulseScheduler({ managers: managerRepository, sessions, bus, describeError });
  const managers = new ManagerService({
    managers: managerRepository, sessions, bus, scheduler: pulseScheduler, heartbeatDefaultSeconds: managerSettings.heartbeatDefaultSeconds,
    scapeImportStatusOf: (sessionId) => scapeImportStatusOfManager(db, sessionId),
  });
  const storeRepo = new DataStoreRepository(db);
  const stores = new DataStoreService({ repo: storeRepo, db, clock: () => new Date().toISOString(), newId });
  const projects = new ProjectRepository(db);
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => new Date().toISOString(), newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => new Date().toISOString(), degraded, onWatchError: logDocsFolderFailure('watch') });
  const docsFolders = new DocsFolderSupervisor({ projects, docs, onError: ({ projectId, step, error }) => logDocsFolderFailure(step, projectId)(error) });
  const projectService = new ProjectService({ projects, docs, clock: () => new Date().toISOString(), newId, onDocsFolderSet: (projectId) => docsFolders.watchProject(projectId) });
  const workingStates = new WorkingStateService({ db, clock: () => new Date().toISOString(), stateRoot: config.stateRoot, maxBytes: workingStateSettings.maxBytes });
  const stopRefusal = new StopRefusal({ db, workingStates, settings: workingStateSettings, clock: () => new Date().toISOString() });
  const sessionStartContext = new SessionStartContext({ db, workingStates, settings: workingStateSettings, clock: () => new Date().toISOString() });
  const handoverLedger = new HandoverLedger({ db, clock: () => new Date().toISOString(), patterns: workingStateSettings.handoverPatterns });
  const contextNotice = new ContextNotice({ sessions, managers: managerRepository, settings: contextNoticeSettings });
  const todos = new TodoTracker({ sessions, bus });
  const { silentBlockMinutes } = loadPermissionSettings(modelConfigPath);
  const silentBlocks = new SilentBlockDetector({ thresholdMinutes: silentBlockMinutes, schedule: scheduleOnRealClock, onChange: (blocks) => bus.emit({ type: 'permission.silent_blocks', blocks }) });
  bus.subscribe((event) => silentBlocks.handle(event));
  const handoffSettings = loadHandoffSettings(modelConfigPath);
  const handoff = createHandoffRouteDeps({ sessions, managers, workingStates, todos, docs, projects, git: createNodeGitPort(), settings: handoffSettings, clock: () => new Date().toISOString() });
  const stopHandoffOnClose = registerHandoffOnClose(bus, handoff.handoffs, { writeOnClose: handoffSettings.writeOnClose, onError: (error) => log('warn', `automatic handoff not written: ${describeError(error).error}`) });

  // The server must be listening before any resumed CLI can POST its first hook — resuming first risks a
  // fast process hitting a port nothing is serving yet.
  const diagnostics = () => buildDiagnosticsDocument({ db, degraded, listSessions: () => sessions.list(), port: config.port, e2eEnabled: config.e2eEnabled });
  const server = await startServer({ ...config, e2eRoutes: config.e2eEnabled, degraded, diagnostics, sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath, notes, noteRepo, docs, stores, storeRepo, projects, projectService, handoff, stopRefusal, sessionStartContext, handoverLedger, contextNotice, todos, silentBlocks, workingStates, workingStateMaxAgeMinutes: workingStateSettings.maxAgeMinutes, mcp: createMcpHandler({ sessions, approvals, managers, pulseScheduler, modelTable, stores, storeRepo, notes, noteRepo, docs, projects, workingStates, worktreesRoot: config.worktreesRoot }) });
  log('info', `openfleet core listening on ${server.url} (version: ${DAEMON_VERSION}, home: ${config.home})`);

  const unwatchDatabase = watchDatabaseHealth(degraded);
  // An issue that clears by itself (hook_fail_open after five clean minutes) is announced on time, not at the next /health.
  const expirySweep = setInterval(() => degraded.list(), ISSUE_EXPIRY_SWEEP_MS);
  expirySweep.unref();
  const close = async () => {
    server.beginShutdown();
    clearInterval(expirySweep);
    unwatchDatabase();
    pulseScheduler.stop();
    contextNotice.stop();
    silentBlocks.stop();
    stopHandoffOnClose();
    docsFolders.stop();
    try {
      await sessions.closeAll();
    } finally {
      sleepGuard.stop();
      await powerApi.close?.();
    }
    todos.stop();
    await server.close();
  };
  try {
    // A launch dir a crashed or killed daemon never cleaned up would otherwise sit on disk carrying a live
    // token indefinitely; every resume below rewrites its own launch dir from scratch with rotated tokens
    // anyway, so nothing here is worth preserving across a restart (AUD-11).
    sweepStaleSessions(config.sessionsRoot);
    docsFolders.start();
    sleepGuard.start();
    await sessions.resumeAll();
    pulseScheduler.start();
  } catch (error) {
    await closeWithin({ timeoutMs: REFUSED_BOOT_CLOSE_TIMEOUT_MS, close });
    throw error;
  }

  return { server, db, degraded, close };
}
