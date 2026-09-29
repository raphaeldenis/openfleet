import { join } from 'node:path';
import { startServer } from './api/server.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { EventBus } from './events/eventBus.js';
import { ApprovalService } from './governance/approvalService.js';
import { ClaudeCliHarness } from './harness/claudeCli/claudeCliHarness.js';
import { sweepStaleSessions } from './harness/claudeCli/tokenFiles.js';
import { FakeHarness } from './harness/fakeHarness.js';
import { ManagerRepository } from './managers/managerRepository.js';
import { ManagerService } from './managers/managerService.js';
import { PulseScheduler } from './managers/pulseScheduler.js';
import { log } from './logger.js';
import { createMcpHandler } from './mcp/mcpServer.js';
import { loadModelTable } from './models.js';
import { DocsFolderService } from './notes/docsFolderService.js';
import { expandMentions } from './notes/mentionExpander.js';
import { nodeDocsFolderFs } from './notes/nodeDocsFolderFs.js';
import { NoteRepository } from './notes/noteRepository.js';
import { NoteService } from './notes/noteService.js';
import { installProcessGuards } from './process/processGuards.js';
import { installShutdownHandler } from './process/shutdownHandler.js';
import { ProjectRepository } from './projects/projectRepository.js';
import { SessionService } from './sessions/sessionService.js';
import { DataStoreRepository } from './stores/dataStoreRepository.js';
import { DataStoreService } from './stores/dataStoreService.js';
import { newId } from './ids.js';
import { loadWorkingStateSettings } from './workingState/workingStateSettings.js';
import { SessionStartContext } from './workingState/sessionStartContext.js';
import { StopRefusal } from './workingState/stopRefusal.js';
import { WorkingStateService } from './workingState/workingStateService.js';

installProcessGuards();

const config = loadConfig();
const db = openDatabase(config.dbPath);
const bus = new EventBus();
const baseUrl = `http://${config.host}:${config.port}`;
const sessions = new SessionService({ db, bus, harnesses: [new ClaudeCliHarness(config.sessionsRoot), new FakeHarness()], baseUrl, worktreesRoot: config.worktreesRoot });
const approvals = new ApprovalService({ db, bus });
// A row still 'pending' from before this boot has no live waiter any more (AUD-07): the pre-restart
// process that would have decided it is gone with the old daemon.
approvals.expireAllPending('daemon restarted');
const modelConfigPath = join(config.home, 'config.json');
const modelTable = loadModelTable(modelConfigPath);
const managerRepository = new ManagerRepository(db);
const pulseScheduler = new PulseScheduler({ managers: managerRepository, sessions, bus });
const managers = new ManagerService({ managers: managerRepository, sessions, bus, scheduler: pulseScheduler });
const storeRepo = new DataStoreRepository(db);
const stores = new DataStoreService({ repo: storeRepo, db, clock: () => new Date().toISOString(), newId });
const projects = new ProjectRepository(db);
const noteRepo = new NoteRepository(db);
const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => new Date().toISOString(), newId });
const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => new Date().toISOString() });
const workingStateSettings = loadWorkingStateSettings(modelConfigPath);
const workingStates = new WorkingStateService({ db, clock: () => new Date().toISOString(), stateRoot: config.stateRoot, maxBytes: workingStateSettings.maxBytes });
const stopRefusal = new StopRefusal({ db, workingStates, settings: workingStateSettings, clock: () => new Date().toISOString() });
const sessionStartContext = new SessionStartContext({ db, workingStates, settings: workingStateSettings, clock: () => new Date().toISOString() });

// The server must be listening before any resumed CLI can POST its first hook — resuming first risks a
// fast process hitting a port nothing is serving yet.
const server = await startServer({ ...config, sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath, notes, noteRepo, docs, stores, storeRepo, projects, stopRefusal, sessionStartContext, workingStates, workingStateMaxAgeMinutes: workingStateSettings.maxAgeMinutes, mcp: createMcpHandler({ sessions, approvals, managers, pulseScheduler, modelTable, stores, storeRepo, notes, noteRepo, docs, workingStates, worktreesRoot: config.worktreesRoot }) });
log('info', `openfleet core listening on ${server.url} (home: ${config.home})`);

// A launch dir a crashed or killed daemon never cleaned up would otherwise sit on disk carrying a live
// token indefinitely; every resume below rewrites its own launch dir from scratch with rotated tokens
// anyway, so nothing here is worth preserving across a restart (AUD-11).
sweepStaleSessions(config.sessionsRoot);
await sessions.resumeAll();
pulseScheduler.start();

installShutdownHandler(async () => {
  pulseScheduler.stop();
  await sessions.closeAll();
  await server.close();
});
