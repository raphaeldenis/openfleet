import { join } from 'node:path';
import { startServer } from './api/server.js';
import type { Config } from './config.js';
import { readingConfigFile } from './configFileError.js';
import { openDatabase } from './db/database.js';
import { describeError } from './errors/describeError.js';
import { EventBus } from './events/eventBus.js';
import { ApprovalService } from './governance/approvalService.js';
import { ClaudeCliHarness } from './harness/claudeCli/claudeCliHarness.js';
import { sweepStaleSessions } from './harness/claudeCli/tokenFiles.js';
import { FakeHarness } from './harness/fakeHarness.js';
import { newId } from './ids.js';
import { log } from './logger.js';
import { DAEMON_VERSION } from './version.js';
import { ManagerRepository } from './managers/managerRepository.js';
import { ManagerService } from './managers/managerService.js';
import { PulseScheduler } from './managers/pulseScheduler.js';
import { createMcpHandler } from './mcp/mcpServer.js';
import { loadModelTable } from './models.js';
import { DocsFolderService } from './notes/docsFolderService.js';
import { expandMentions } from './notes/mentionExpander.js';
import { nodeDocsFolderFs } from './notes/nodeDocsFolderFs.js';
import { NoteRepository } from './notes/noteRepository.js';
import { NoteService } from './notes/noteService.js';
import { closeWithin } from './process/boundedClose.js';
import { ProjectRepository } from './projects/projectRepository.js';
import { SessionService } from './sessions/sessionService.js';
import { DataStoreRepository } from './stores/dataStoreRepository.js';
import { DataStoreService } from './stores/dataStoreService.js';
import { ContextNotice } from './workingState/contextNotice.js';
import { HandoverLedger } from './workingState/handoverLedger.js';
import { SessionStartContext } from './workingState/sessionStartContext.js';
import { StopRefusal } from './workingState/stopRefusal.js';
import { WorkingStateService } from './workingState/workingStateService.js';
import { loadDaemonSettings } from './workingState/workingStateSettings.js';

const REFUSED_BOOT_CLOSE_TIMEOUT_MS = 5000;

export interface Daemon {
  server: Awaited<ReturnType<typeof startServer>>;
  db: ReturnType<typeof openDatabase>;
  close: () => Promise<void>;
}

// Builds every service from the config and starts serving; a throw at any point refuses the boot, after closing whatever already started.
export async function startDaemon(config: Config): Promise<Daemon> {
  const db = openDatabase(config.dbPath);
  const bus = new EventBus();
  const baseUrl = `http://${config.host}:${config.port}`;
  const harnesses = config.e2eEnabled ? [new ClaudeCliHarness(config.sessionsRoot), new FakeHarness()] : [new ClaudeCliHarness(config.sessionsRoot)];
  if (config.e2eEnabled) log('warn', 'e2e test surface enabled (OPENFLEET_E2E=1): fake harness and fake-output route are registered');
  const sessions = new SessionService({ db, bus, harnesses, baseUrl, worktreesRoot: config.worktreesRoot, describeError });
  const approvals = new ApprovalService({ db, bus });
  // A row still 'pending' from before this boot has no live waiter any more (AUD-07): the pre-restart
  // process that would have decided it is gone with the old daemon.
  approvals.expireAllPending('daemon restarted');
  const modelConfigPath = join(config.home, 'config.json');
  const modelTable = readingConfigFile(() => loadModelTable(modelConfigPath));
  const { workingState: workingStateSettings, managers: managerSettings, contextNotice: contextNoticeSettings } = readingConfigFile(() => loadDaemonSettings(modelConfigPath));
  const managerRepository = new ManagerRepository(db);
  const pulseScheduler = new PulseScheduler({ managers: managerRepository, sessions, bus });
  const managers = new ManagerService({ managers: managerRepository, sessions, bus, scheduler: pulseScheduler, heartbeatDefaultSeconds: managerSettings.heartbeatDefaultSeconds });
  const storeRepo = new DataStoreRepository(db);
  const stores = new DataStoreService({ repo: storeRepo, db, clock: () => new Date().toISOString(), newId });
  const projects = new ProjectRepository(db);
  const noteRepo = new NoteRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => new Date().toISOString(), newId });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => new Date().toISOString() });
  const workingStates = new WorkingStateService({ db, clock: () => new Date().toISOString(), stateRoot: config.stateRoot, maxBytes: workingStateSettings.maxBytes });
  const stopRefusal = new StopRefusal({ db, workingStates, settings: workingStateSettings, clock: () => new Date().toISOString() });
  const sessionStartContext = new SessionStartContext({ db, workingStates, settings: workingStateSettings, clock: () => new Date().toISOString() });
  const handoverLedger = new HandoverLedger({ db, clock: () => new Date().toISOString(), patterns: workingStateSettings.handoverPatterns });
  const contextNotice = new ContextNotice({ sessions, managers: managerRepository, settings: contextNoticeSettings });

  // The server must be listening before any resumed CLI can POST its first hook — resuming first risks a
  // fast process hitting a port nothing is serving yet.
  const server = await startServer({ ...config, e2eRoutes: config.e2eEnabled, sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath, notes, noteRepo, docs, stores, storeRepo, projects, stopRefusal, sessionStartContext, handoverLedger, contextNotice, workingStates, workingStateMaxAgeMinutes: workingStateSettings.maxAgeMinutes, mcp: createMcpHandler({ sessions, approvals, managers, pulseScheduler, modelTable, stores, storeRepo, notes, noteRepo, docs, workingStates, worktreesRoot: config.worktreesRoot }) });
  log('info', `openfleet core listening on ${server.url} (version: ${DAEMON_VERSION}, home: ${config.home})`);

  // A launch dir a crashed or killed daemon never cleaned up would otherwise sit on disk carrying a live
  // token indefinitely; every resume below rewrites its own launch dir from scratch with rotated tokens
  // anyway, so nothing here is worth preserving across a restart (AUD-11).
  const close = async () => {
    pulseScheduler.stop();
    contextNotice.stop();
    await sessions.closeAll();
    await server.close();
  };
  try {
    sweepStaleSessions(config.sessionsRoot);
    await sessions.resumeAll();
    pulseScheduler.start();
  } catch (error) {
    await closeWithin({ timeoutMs: REFUSED_BOOT_CLOSE_TIMEOUT_MS, close });
    throw error;
  }

  return { server, db, close };
}
