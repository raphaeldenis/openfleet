import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
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
import { ArbiterRunner } from './escalation/arbiterRunner.js';
import { createArbiterWorkspaces } from './escalation/arbiterWorkspaces.js';
import { AskUserGate } from './escalation/askUserGate.js';
import { AuditWriter } from './escalation/auditWriter.js';
import { CriteriaApproval } from './escalation/criteriaApproval.js';
import { CriteriaStatusGuard } from './escalation/criteriaStatusGuard.js';
import { EscalationRepository } from './escalation/escalationRepository.js';
import { EscalationService } from './escalation/escalationService.js';
import { GovernanceQueueService } from './governance/governanceQueueService.js';
import { MAX_CONCURRENT_RUNS, MAX_RUNS_NEEDING_REVIEW, MAX_STEP_EXECUTIONS_PER_RUN, OpenFleetError, type EscalationView } from '@openfleet/shared';
import { decisionNotification, escalationAnswerNotification } from './governance/decisionNotification.js';
import { loadPermissionSettings } from './governance/permissionSettings.js';
import { SilentBlockDetector } from './governance/silentBlockDetector.js';
import { ClaudeCliHarness } from './harness/claudeCli/claudeCliHarness.js';
import { ClaudePolicyHooks } from './harness/claudeCli/claudePolicyHooks.js';
import { CommandPolicyService } from './policy/commandPolicyService.js';
import { defaultCommandPolicySettings, type CommandPolicySettings, type PolicyEvaluate } from './policy/commandPolicySettings.js';
import { createFileCommandPolicyFile } from './policy/fileCommandPolicyFile.js';
import { evaluateCommandPolicy } from './policy/policyEvaluator.js';
import { RefusalRepeatGuard } from './policy/refusalRepeatGuard.js';
import { SqliteDenialJournal } from './policy/sqliteDenialJournal.js';
import { ActivityRecorder } from './activity/activityRecorder.js';
import { ActivityRepository } from './activity/activityRepository.js';
import { createNonceLedger } from './secrets/nonceLedger.js';
import { createOperatorHumanProof } from './secrets/operatorHumanProof.js';
import { createParentBridgeSecretStore } from './secrets/parentBridgeSecretStore.js';
import type { SecretParentLink } from './secrets/secretParentLink.js';
import { SecretRefRepository } from './secrets/secretRefRepository.js';
import { SecretService } from './secrets/secretService.js';
import { createUnavailableSecretStore, type SecretStore } from './secrets/secretStore.js';

/** Shorter than the 30 seconds a nonce lives, so a request that waits out the app also finds its nonces expired. */
const DEFAULT_SECRET_EXCHANGE_TIMEOUT_MS = 15_000;
import { ManagerDenials } from './policy/managerDenials.js';
import { FINDINGS_GATE_ENFORCEMENT, FindingsGate, type FindingsGateEnforcement } from './review/findingsGate.js';
import { ReviewFindingsRepository } from './review/reviewFindingsRepository.js';
import { TranscriptUsageIngestion } from './usage/transcriptUsageIngestion.js';
import { UsageLedgerService } from './usage/usageLedgerService.js';
import { descendantSessionIdsOf, lineageRootIdOf } from './managers/lineage.js';
import { SystemActivity } from './activity/systemActivity.js';
import type { BaseNotReadEnforcement } from './managers/baseReadGuard.js';
import type { NoteNotReadEnforcement } from './managers/noteReadGuard.js';
import { loadManagerBase, managerBaseView, type ManagerBase } from './managers/managerBase.js';
import { sweepStaleSessions } from './harness/claudeCli/tokenFiles.js';
import { FakeHarness, postSessionStartHook } from './harness/fakeHarness.js';
import type { Harness } from './harness/harness.js';
import { newId } from './ids.js';
import { createNodeGitPort } from './git/nodeGitPort.js';
import { log } from './logger.js';
import { CaffeinatePowerApi } from './power/caffeinatePowerApi.js';
import type { PowerApi } from './power/powerApi.js';
import { loadPowerSettings } from './power/powerSettings.js';
import { SleepGuard } from './power/sleepGuard.js';
import { DAEMON_VERSION } from './version.js';
import { scapeImportStatusOfManager } from './import/scape/scapeManagerEditStatus.js';
import { profileRecallOf } from './managers/managerProfileRecall.js';
import { ManagerRepository } from './managers/managerRepository.js';
import { ManagerService } from './managers/managerService.js';
import { ProjectProfileBootstrap } from './managers/projectProfileBootstrap.js';
import { IdleChildWatcher } from './managers/idleChildWatcher.js';
import { PulseScheduler } from './managers/pulseScheduler.js';
import { ScheduledEventRepository } from './managers/scheduledEventRepository.js';
import { ScheduledEventService } from './managers/scheduledEventService.js';
import { ChildSilenceRepository } from './managers/childSilenceRepository.js';
import { ChildSilenceWatch, DEFAULT_SILENCE_CHECK_DELAY_MS } from './managers/childSilenceWatch.js';
import { CiWatchService } from './managers/ciWatchService.js';
import { WatchedPrRepository } from './managers/watchedPrRepository.js';
import { createGhPullRequestPort, type GhPullRequestPort } from './github/ghPullRequestPort.js';
import { createGhPullRequestReader, type GhPullRequestReader } from './github/ghPullRequestReader.js';
import { staleInProgressRowLabelsOfProject } from './managers/staleRows.js';
import { createMcpHandler } from './mcp/mcpServer.js';
import type { HumanProofVerifier } from './triggers/humanProofVerifier.js';
import { toSingleLineName } from './managers/singleLineName.js';
import { CronSource } from './triggers/cronSource.js';
import { SessionStateSource } from './triggers/sessionStateSource.js';
import { SilentRunSource } from './triggers/silentRunSource.js';
import { TableSource } from './triggers/tableSource.js';
import { FireBreaker } from './triggers/fireBreaker.js';
import { FireLedger } from './triggers/fireLedger.js';
import { FireRetention } from './triggers/fireRetention.js';
import { createTriggerActions } from './triggers/triggerActions.js';
import { TriggerCursors } from './triggers/triggerCursors.js';
import { TriggerEngine, type SettledFire } from './triggers/triggerEngine.js';
import { TriggerRepository } from './triggers/triggerRepository.js';
import { TriggerService } from './triggers/triggerService.js';
import { PlaybookRepository } from './playbooks/playbookRepository.js';
import { PlaybookVersionRepository } from './playbooks/playbookVersionRepository.js';
import { PlaybookService } from './playbooks/playbookService.js';
import { PlaybookApprovals } from './playbooks/playbookApprovals.js';
import { PlaybookRunner } from './playbooks/playbookRunner.js';
import { PlaybookRunRepository } from './playbooks/playbookRunRepository.js';
import { ScriptLocator } from './playbooks/scriptLocator.js';
import { pendingPermissionViewOf } from './mcp/pendingPermissionView.js';
import { KnowledgeRepository } from './knowledge/knowledgeRepository.js';
import { KnowledgeRepoScope } from './knowledge/knowledgeRepoScope.js';
import { KnowledgeSearchService } from './knowledge/knowledgeSearchService.js';
import { loadModelTable } from './models.js';
import { DocsFolderService } from './notes/docsFolderService.js';
import { registerHandoffOnClose } from './notes/handoffService.js';
import { ChildAutoRestarter } from './managers/childAutoRestarter.js';
import { SleepHandoff } from './managers/sleepHandoff.js';
import { ChildRestartLedger } from './managers/childRestartLedger.js';
import { ArtifactDirectory } from './artifacts/artifactDirectory.js';
import { loadArtifactSettings } from './artifacts/artifactSettings.js';
import { SqliteArtifactJournal } from './artifacts/sqliteArtifactJournal.js';
import { loadHandoffSettings } from './notes/handoffSettings.js';
import { DocsRootSettings } from './notes/docsRootSettings.js';
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
import { WorktreeService } from './worktrees/worktreeService.js';
import type { BinaryHealthCheck } from './harness/binaryHealth.js';
import { DEFAULT_LAUNCH_OUTPUT_TIMEOUT_MS, SessionService } from './sessions/sessionService.js';
import { DataStoreRepository } from './stores/dataStoreRepository.js';
import { DataStoreService } from './stores/dataStoreService.js';
import { TodoTracker } from './todos/todoTracker.js';
import { ContextNotice } from './workingState/contextNotice.js';
import { HandoverLedger } from './workingState/handoverLedger.js';
import { SessionStartContext } from './workingState/sessionStartContext.js';
import { StopRefusal } from './workingState/stopRefusal.js';
import { WorkingStateService } from './workingState/workingStateService.js';
import { loadDaemonSettings } from './workingState/workingStateSettings.js';

const COMMAND_POLICY_FILE_NAME = 'command-policy.json';
const ARBITER_WORKSPACES_DIRECTORY = 'arbiter-workspaces';
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
  governanceQueue: GovernanceQueueService;
  scheduledEvents: ScheduledEventService;
  ciWatch: CiWatchService;
  /** The entry point of the trigger sources: they offer events, the engine fires. */
  triggerEngine: TriggerEngine;
  /** The data stores service the REST routes and the tools use. */
  stores: DataStoreService;
  askUserGate: AskUserGate;
  criteriaStatusGuard: CriteriaStatusGuard;
  harnesses: Harness[];
  /** The secrets service the REST routes use; a playbook run resolves its values through it. */
  secrets: SecretService;
  /** Runs the approved script cells of playbooks; its steps are journaled and a step found running at boot is never started again. */
  playbookRunner: PlaybookRunner;
  /** The health of the line to the desktop app: how many answers it ignored because no request in flight claimed them. */
  secretChannel: { ignoredAnswerCount: () => number };
  close: () => Promise<void>;
}

export interface DaemonOptions {
  /** The registry the process guards already mark; the daemon makes its own when none is handed over. */
  degraded?: DegradedRegistry;
  claudeConfigPath?: string;
  /** Replaces the real `--version` check of the harness binary before a spawn, so a test can boot a daemon whose binary is a stand-in. */
  binaryHealth?: BinaryHealthCheck;
  /** How long a new session waits for its harness's start signal before it fails; absent: the harness's own delay, else 60 seconds. */
  firstStartTimeoutMs?: number;
  /** Overrides BASE_NOT_READ_ENFORCEMENT: 'warn_only' turns the base_not_read refusal of a spawn into a warning. */
  baseNotReadEnforcement?: BaseNotReadEnforcement;
  /** Overrides NOTE_NOT_READ_ENFORCEMENT: 'refuse' turns the note_not_read warning of a spawn into a refusal; absent, the warning only warns. */
  noteNotReadEnforcement?: NoteNotReadEnforcement;
  /** Overrides FINDINGS_GATE_ENFORCEMENT and the findingsGate.enforcement setting: 'observe' journals the findings_required refusal of gh pr create and lets the command pass. */
  findingsGateEnforcement?: FindingsGateEnforcement;
  /** When true, each Stop hook hands the session's transcript to the usage ledger, which keeps only token counts; absent or false, no transcript is read for usage. */
  usageIngestion?: boolean;
  /** Replaces the base this build ships, so a test can boot a daemon that ships a newer version. */
  managerBase?: ManagerBase;
  /** Replaces the GitHub CLI the daemon polls the checks of watched pull requests with, so a test needs no network and no login. */
  gh?: GhPullRequestPort;
  /** Reads the pull requests of the list_github_prs and get_github_pr tools; defaults to the user's gh. */
  ghReader?: GhPullRequestReader;
  /** The injection point of the command policy: the settings the daemon enforces and the evaluator that applies them. */
  commandPolicy?: { settings?: CommandPolicySettings; evaluate?: PolicyEvaluate };
  /** Overrides the delay after which an undecided approval expires, so a test does not wait the nine minutes of the hook timeout. */
  approvalTimeoutMs?: number;
  /** Replaces the clock and the timer of the automatic child restarts, so a test does not wait their delays. */
  childRestart?: {
    clock?: () => number;
    schedule?: (callback: () => void, delayMs: number) => () => void;
  };
  /** Replaces the delay, the clock and the timer of the silence check armed when a manager messages a child, so a test does not wait ten minutes. */
  childSilence?: {
    delayMs?: number;
    clock?: () => number;
    schedule?: (callback: () => void, delayMs: number) => () => void;
  };
  /** Replaces the timer of the silent block threshold, so a test raises the block when it chooses. */
  silentBlocks?: {
    schedule?: (callback: () => void, delayMs: number) => () => void;
  };
  /** Replaces the timer of the arbiter expiry, so a test does not wait the two pulses of the manager. */
  arbiter?: {
    schedule?: (callback: () => void, delayMs: number) => () => void;
  };
  /** Tells whether a proof of arming was minted by a human gesture; absent, no proof is good and no trigger can be armed. */
  humanProof?: HumanProofVerifier;
  /** Replaces the clock of the trigger engine (epoch milliseconds), so a test decides when a fire is accepted, how old a backlog is and which day it is. */
  triggers?: { clock?: () => number; schedule?: (callback: () => void, delayMs: number) => () => void };
  /** Replaces the timer of the daily purge of the trigger fires, apart from `triggers.schedule` so that a test counting the timers of the sources does not see it. */
  fireRetention?: { schedule?: (callback: () => void, delayMs: number) => () => void; letTheEventLoopRun?: () => Promise<void> };
  power?: {
    api?: PowerApi;
    clock?: () => number;
    schedule?: (callback: () => void, delayMs: number) => () => void;
  };
  /**
   * The runner of playbooks. `scriptRoots` replaces the `playbooks.scriptRoots` of config.json (the directories a script cell may run files from);
   * `maxStepExecutions` and `maxConcurrentRuns` replace the caps of 1000 step executions per run and 4 runs at once, so a test reaches them with a few steps.
   */
  playbooks?: { scriptRoots?: string[]; maxStepExecutions?: number; maxConcurrentRuns?: number; maxRunsNeedingReview?: number };
  /**
   * The secrets of playbooks. `parent` is the line to the desktop app that spawned the daemon (stdout and stdin of the sidecar); with it the keychain of the app holds the values.
   * `store` replaces the keychain adapter with another holder, so a test needs no desktop app. `clock` and `exchangeTimeoutMs` replace the clock of the nonces and the wait for the app's answer.
   * Without `parent` and `store` nothing can be set or read: the typed error is secret_store_unavailable.
   */
  secrets?: { parent?: SecretParentLink; store?: SecretStore; clock?: () => number; monotonicClock?: () => number; exchangeTimeoutMs?: number };
}

// Builds every service from the config and starts serving; a throw at any point refuses the boot, after closing whatever already started.
// `claudeConfigPath` redirects the folder trust writes of the claude CLI harness; the default is the user's ~/.claude.json.
export async function startDaemon(config: Config, options: DaemonOptions = {}): Promise<Daemon> {
  const { degraded = createDegradedRegistry() } = options;
  const shippedManagerBase = options.managerBase ?? loadManagerBase();
  const managerBase = managerBaseView(shippedManagerBase);
  const db = openDatabase(config.dbPath);
  const bus = new EventBus();
  const baseUrl = `http://${config.host}:${config.port}`;
  const claudeCliHarness = new ClaudeCliHarness(config.sessionsRoot, process.env, options.claudeConfigPath);
  const harnesses = config.e2eEnabled ? [claudeCliHarness, new FakeHarness({ reportSessionStart: postSessionStartHook })] : [claudeCliHarness];
  if (config.e2eEnabled) log('warn', 'e2e test surface enabled (OPENFLEET_E2E=1): fake harness, fake-output route and fake-propose-law route are registered');
  const managerRepository = new ManagerRepository(db);
  const evaluatePolicy = options.commandPolicy?.evaluate ?? evaluateCommandPolicy;
  const commandPolicyService = new CommandPolicyService({
    base: options.commandPolicy?.settings ?? defaultCommandPolicySettings(),
    file: createFileCommandPolicyFile(join(config.home, COMMAND_POLICY_FILE_NAME)),
    evaluate: evaluatePolicy,
  });
  const isCommandPolicyActive = () => {
    const { document, unattended } = commandPolicyService.settings();
    return document.mode !== 'off' || unattended.askBecomesDeny;
  };
  const sessions = new SessionService({ db, bus, harnesses, baseUrl, worktreesRoot: config.worktreesRoot, describeError, binaryHealth: options.binaryHealth, firstStartTimeoutMs: options.firstStartTimeoutMs, launchOutputTimeoutMs: DEFAULT_LAUNCH_OUTPUT_TIMEOUT_MS, missionOf: (sessionId) => managerRepository.get(sessionId)?.missionText, isDeliveryHeld: (sessionId) => managerRepository.get(sessionId)?.mode === 'disabled', isMessageObsolete: (message) => managerRepository.isObsoleteSleepHandoff(message), profileRecallOf: (sessionId) => profileRecallOf(managerRepository.get(sessionId) ?? {}), isCommandPolicyActive });
  const approvals = new ApprovalService({ db, bus, timeoutMs: options.approvalTimeoutMs });
  // A row still 'pending' from before this boot has no live waiter any more (AUD-07): the pre-restart
  // process that would have decided it is gone with the old daemon.
  approvals.expireAllPending('daemon restarted');
  const modelConfigPath = join(config.home, 'config.json');
  const modelTable = readingConfigFile(() => loadModelTable(modelConfigPath));
  const { workingState: workingStateSettings, managers: managerSettings, contextNotice: contextNoticeSettings, findingsGate: findingsGateSettings, playbooks: playbookSettings, triggers: triggerSettings } = readingConfigFile(() => loadDaemonSettings(modelConfigPath));
  const powerSettings = readingConfigFile(() => loadPowerSettings(modelConfigPath));
  const reportPowerUnavailable = () => degraded.mark('power_assertion_unavailable', 'Idle sleep protection is unavailable or its helper cannot be stopped.');
  const powerApi = options.power?.api ?? new CaffeinatePowerApi({ onPowerUnavailable: reportPowerUnavailable });
  const supportsPowerAssertions = options.power?.api !== undefined || process.platform === 'darwin';
  const sleepGuard = new SleepGuard({ sessions, bus, power: powerApi,
    enabled: supportsPowerAssertions && powerSettings.preventIdleSleepWhileGenerating,
    clock: options.power?.clock ?? Date.now, schedule: options.power?.schedule ?? scheduleOnRealClock,
    onPowerUnavailable: reportPowerUnavailable,
    onPowerAvailable: () => degraded.clear('power_assertion_unavailable'),
  });
  sleepGuard.observeSessionEvents();
  const managerDenials = new ManagerDenials({ db, lineageSessionIdsOf: (managerId) => descendantSessionIdsOf(sessions.list(), managerId) });
  const deniedCommandCountsOf = (managerId: string) => managerDenials.countsOf(managerId);
  const storeRepo = new DataStoreRepository(db);
  const staleRowLabelsOf = (managerId: string) => {
    const projectId = sessions.get(managerId)?.projectId;
    return projectId === undefined ? [] : staleInProgressRowLabelsOfProject({ stores: storeRepo, projectId, now: Date.now() });
  };
  const pulseScheduler = new PulseScheduler({ managers: managerRepository, sessions, bus, describeError, deniedCommandCountsOf, managerBase: shippedManagerBase, staleRowLabelsOf });
  const idleChildWatcher = new IdleChildWatcher({ managers: managerRepository, sessions });
  const noteRepo = new NoteRepository(db);
  const managers = new ManagerService({
    managers: managerRepository, sessions, bus, scheduler: pulseScheduler, heartbeatDefaultSeconds: managerSettings.heartbeatDefaultSeconds, deniedCommandCountsOf, currentBase: shippedManagerBase,
    scapeImportStatusOf: (sessionId) => scapeImportStatusOfManager(db, sessionId),
    linkTargets: { noteProjectId: (noteId) => noteRepo.getProjectId(noteId), storeProjectId: (storeId) => storeRepo.findStore(storeId)?.projectId },
  });
  const childAutoRestarter = new ChildAutoRestarter({
    bus, sessions, managers: managerRepository, ledger: new ChildRestartLedger(db),
    clock: options.childRestart?.clock ?? Date.now, schedule: options.childRestart?.schedule ?? scheduleOnRealClock,
  });
  const sleepHandoff = new SleepHandoff({ bus, sessions, managers: managerRepository, clock: () => new Date().toISOString() });
  bus.subscribe((event) => {
    const isReactivated = event.type === 'manager.updated' && event.manager.mode !== 'disabled';
    if (isReactivated) sessions.resumeHeldDelivery(event.manager.sessionId);
  });
  const governanceQueue = new GovernanceQueueService({
    db, bus, clock: () => new Date().toISOString(), newId,
    notifyDecision: (input) => {
      const sessionId = input.proposal.managerId;
      const isOpen = sessions.get(sessionId)?.state !== 'closed';
      if (!isOpen) return;
      try {
        sessions.sendMessage({ sessionId, messageId: `governance-${input.proposal.id}`, body: decisionNotification(input) });
      } catch (error) {
        log('warn', `governance: the manager could not be told: ${describeError(error).error}`, sessionId);
      }
    },
    managers: { isManager: (sessionId) => managerRepository.get(sessionId) !== undefined, projectIdOf: (sessionId) => sessions.get(sessionId)?.projectId },
    linkTargets: { noteProjectId: (noteId) => noteRepo.getProjectId(noteId), storeProjectId: (storeId) => storeRepo.findStore(storeId)?.projectId },
  });
  const knowledgeRepository = new KnowledgeRepository(db);
  const knowledgeService = new KnowledgeSearchService({ search: knowledgeRepository, scope: new KnowledgeRepoScope({ repositories: knowledgeRepository }) });
  const knowledgeSearch = { search: knowledgeService.search.bind(knowledgeService) };
  const stores = new DataStoreService({ repo: storeRepo, db, clock: () => new Date().toISOString(), newId });
  const projects = new ProjectRepository(db);
  const notes = new NoteService({ repo: noteRepo, db, expandMentions, clock: () => new Date().toISOString(), newId, publishChange: (event) => bus.emit(event) });
  const docs = new DocsFolderService({ notes, noteRepo, projects, fs: nodeDocsFolderFs, clock: () => new Date().toISOString(), degraded, onWatchError: logDocsFolderFailure('watch') });
  const docsFolders = new DocsFolderSupervisor({ projects, docs, onError: ({ projectId, step, error }) => logDocsFolderFailure(step, projectId)(error) });
  const docsRoot = new DocsRootSettings({ configPath: modelConfigPath, homeDir: homedir(), openfleetHome: config.home });
  const projectService = new ProjectService({ projects, docs, noteRepo, docsRoot, clock: () => new Date().toISOString(), newId, onDocsFolderSet: (projectId) => docsFolders.watchProject(projectId), onProjectForgotten: (projectId) => docsFolders.unwatchProject(projectId) });
  const workingStates = new WorkingStateService({ db, clock: () => new Date().toISOString(), stateRoot: config.stateRoot, maxBytes: workingStateSettings.maxBytes });
  const stopRefusal = new StopRefusal({ db, workingStates, settings: workingStateSettings, clock: () => new Date().toISOString() });
  const sessionStartContext = new SessionStartContext({ db, workingStates, settings: workingStateSettings, clock: () => new Date().toISOString(), managerBase: shippedManagerBase });
  const handoverLedger = new HandoverLedger({ db, clock: () => new Date().toISOString(), patterns: workingStateSettings.handoverPatterns });
  const contextNotice = new ContextNotice({ sessions, managers: managerRepository, settings: contextNoticeSettings });
  const todos = new TodoTracker({ sessions, bus });
  const { silentBlockMinutes, unattendedSilentBlockSeconds } = loadPermissionSettings(modelConfigPath);
  const isManager = (sessionId: string) => managerRepository.get(sessionId) !== undefined;
  /** A child whose permission dialogs become refusals: nobody ever answers a dialog it opens, so it must not wait on one for long. */
  const isChildNobodyWatches = (sessionId: string) => {
    const hasParent = sessions.get(sessionId)?.parentId !== undefined;
    return hasParent && !isManager(sessionId) && commandPolicyService.settings().unattended.askBecomesDeny;
  };
  const tellManagerOfSilentBlock = ({ sessionId, wasUnwatched }: { sessionId: string; wasUnwatched: boolean }) => {
    const session = sessions.get(sessionId);
    const manager = session?.parentId;
    if (!wasUnwatched || session === undefined || manager === undefined) return;
    const pendingApproval = approvals.listPending().find((approval) => approval.sessionId === sessionId);
    const pendingPermission = pendingApproval && pendingPermissionViewOf(pendingApproval, new Date());
    const waitingOn = pendingPermission ? ` It waits on ${pendingPermission.toolName}: ${pendingPermission.input}` : '';
    const body = `[OpenFleet] ${session.name} (${session.id}) has waited more than ${unattendedSilentBlockSeconds} seconds on a permission prompt nobody can answer.${waitingOn} Look at it, or close and relaunch it.`;
    try {
      sessions.sendMessage({ sessionId: manager, body });
    } catch (error) {
      log('warn', `silent block: the manager could not be told: ${describeError(error).error}`, sessionId);
    }
  };
  const silentBlocks = new SilentBlockDetector({
    thresholdMinutes: silentBlockMinutes,
    unattended: { thresholdSeconds: unattendedSilentBlockSeconds, appliesTo: isChildNobodyWatches },
    schedule: options.silentBlocks?.schedule ?? scheduleOnRealClock,
    onChange: (blocks) => bus.emit({ type: 'permission.silent_blocks', blocks }),
    onRaised: tellManagerOfSilentBlock,
  });
  bus.subscribe((event) => silentBlocks.handle(event));
  const handoffSettings = loadHandoffSettings(modelConfigPath);
  const reviewFindings = new ReviewFindingsRepository(db);
  const tellManagerOfEscalationAnswer = (escalation: EscalationView) => {
    const sessionId = escalation.managerId;
    const isOpen = sessions.get(sessionId)?.state !== 'closed';
    if (!isOpen) return;
    try {
      sessions.sendMessage({ sessionId, messageId: `escalation-${escalation.id}`, body: escalationAnswerNotification(escalation) });
    } catch (error) {
      log('warn', `escalation: the manager could not be told: ${describeError(error).error}`, sessionId);
    }
  };
  const escalationRepository = new EscalationRepository(db);
  const escalationAudit = new AuditWriter({ notes, noteRepo, managers, sessions, stores, storeRepo });
  const escalations = new EscalationService({ db, repository: escalationRepository, workingStates, audit: escalationAudit, clock: () => new Date().toISOString(), newId, bus, notifyAnswer: tellManagerOfEscalationAnswer });
  const criteriaStatusGuard = new CriteriaStatusGuard({ projects, managers, sessions, audit: escalationAudit });
  stores.observeRowWrites(criteriaStatusGuard);
  const criteria = new CriteriaApproval({ repository: escalationRepository, noteRepo, stores, storeRepo, audit: escalationAudit });
  const arbiters = new ArbiterRunner({
    sessions, bus, managers, projects, repository: escalationRepository, escalations, modelTable,
    workspaces: createArbiterWorkspaces(join(config.home, ARBITER_WORKSPACES_DIRECTORY)), realPathOf: (path) => realpathSync.native(path),
    schedule: options.arbiter?.schedule ?? scheduleOnRealClock, ticketPattern: findingsGateSettings.ticketPattern,
  });
  const usageLedger = new UsageLedgerService(db);
  const usageIngestion = options.usageIngestion === true
    ? new TranscriptUsageIngestion({ ledger: usageLedger, trustedTranscriptFileOf: (sessionId) => sessions.trustedTranscriptFileOf(sessionId), parentOf: (sessionId) => sessions.get(sessionId)?.parentId, createdAtOf: (sessionId) => sessions.get(sessionId)?.createdAt })
    : undefined;
  bus.subscribe((event) => {
    if (event.type === 'session.closed') usageIngestion?.forget(event.sessionId);
  });
  const findingsGate = {
    gate: new FindingsGate({ findings: reviewFindings, ticketPattern: findingsGateSettings.ticketPattern }),
    enforcement: options.findingsGateEnforcement ?? findingsGateSettings.enforcement ?? FINDINGS_GATE_ENFORCEMENT,
  };
  const denialJournal = new SqliteDenialJournal({ db, clock: () => new Date().toISOString() });
  const activityRepository = new ActivityRepository(db);
  const activity = new ActivityRecorder({ repository: activityRepository, clock: () => new Date().toISOString(), onFailure: (error) => log('warn', 'the activity log could not be written', error) });
  activity.pruneAtBoot();
  const systemActivity = new SystemActivity(activity);
  bus.subscribe((event) => {
    if (event.type !== 'manager.pulsed') return;
    const managerSessionId = event.manager.sessionId;
    const lineageRootId = lineageRootIdOf(sessions, sessions.get(managerSessionId) ?? { id: managerSessionId });
    systemActivity.pulseSent({ managerSessionId, lineageRootId });
  });
  const askUserGate = new AskUserGate({ db, projects, repository: escalationRepository, audit: escalationAudit, denials: denialJournal, clock: () => new Date().toISOString() });
  const artifacts = new ArtifactDirectory({
    docsFolderPathOf: (projectId) => projects.get(projectId)?.docsFolderPath ?? undefined,
    settings: loadArtifactSettings(modelConfigPath),
    journal: new SqliteArtifactJournal({ db, clock: () => new Date().toISOString() }),
  });
  const commandPolicy = new ClaudePolicyHooks({
    settings: () => commandPolicyService.settings(),
    evaluate: evaluatePolicy,
    sessions, isManager, bus, degraded, findingsGate, artifacts,
    journal: denialJournal,
    repeatGuard: new RefusalRepeatGuard({ clock: Date.now, settings: () => commandPolicyService.settings().unattended.escalateAfterRepeats }),
  });
  const handoff = createHandoffRouteDeps({ sessions, managers, workingStates, todos, docs, projects, git: createNodeGitPort(), settings: handoffSettings, clock: () => new Date().toISOString() });
  const stopHandoffOnClose = registerHandoffOnClose(bus, handoff.handoffs, { writeOnClose: handoffSettings.writeOnClose, onError: (error) => log('warn', `automatic handoff not written: ${describeError(error).error}`) });

  // The server must be listening before any resumed CLI can POST its first hook — resuming first risks a
  // fast process hitting a port nothing is serving yet.
  const diagnostics = () => buildDiagnosticsDocument({ db, degraded, listSessions: () => sessions.list(), port: config.port, e2eEnabled: config.e2eEnabled });
  const worktrees = new WorktreeService({ projects, sessions, worktreesRoot: config.worktreesRoot });
  const scheduledEvents = new ScheduledEventService({ repository: new ScheduledEventRepository(db), sessions, managers: managerRepository, bus });
  const childSilence = new ChildSilenceWatch({
    sessions, managers: managerRepository, bus, checks: new ChildSilenceRepository(db), delayMs: options.childSilence?.delayMs ?? DEFAULT_SILENCE_CHECK_DELAY_MS,
    clock: options.childSilence?.clock ?? Date.now, schedule: options.childSilence?.schedule ?? scheduleOnRealClock,
  });
  const githubReader = options.ghReader ?? createGhPullRequestReader();
  const ciWatch = new CiWatchService({ repository: new WatchedPrRepository(db), gh: options.gh ?? createGhPullRequestPort(), scheduledEvents });
  const secretMonotonicClock = options.secrets?.monotonicClock ?? (() => performance.now());
  const secretNonces = createNonceLedger({ monotonicClock: secretMonotonicClock });
  const secretParent = options.secrets?.parent;
  const secretBridge = secretParent === undefined ? undefined : createParentBridgeSecretStore({ link: secretParent, monotonicClock: secretMonotonicClock, exchangeTimeoutMs: options.secrets?.exchangeTimeoutMs ?? DEFAULT_SECRET_EXCHANGE_TIMEOUT_MS });
  secretParent?.onMessage((message) => {
    if (message.type === 'operator_nonce') secretNonces.register(message.nonce, { action: message.action, scope: { kind: message.scopeKind, id: message.scopeId }, name: message.name });
  });
  const secrets = new SecretService({ refs: new SecretRefRepository(db), store: options.secrets?.store ?? secretBridge ?? createUnavailableSecretStore(), clock: options.secrets?.clock ?? Date.now });
  const secretChannel = { ignoredAnswerCount: () => secretBridge?.ignoredAnswerCount() ?? 0 };
  const humanProof = options.humanProof ?? createOperatorHumanProof(secretNonces);
  const triggerRepository = new TriggerRepository(db);
  const triggers = new TriggerService({ repository: triggerRepository, humanProof, projectExists: (projectId) => projects.get(projectId) !== undefined, clock: () => new Date().toISOString(), newId, onArmed: (armed) => { sessionStateSource.rescan(); tableSource.startFromNow(armed); cronSource.startFromNow(armed); silentRunSource.startFromNow(armed); }, onChanged: (triggerId) => { cronSource.sync(triggerId); silentRunSource.sync(triggerId); } });
  const triggerClock = options.triggers?.clock ?? Date.now;
  const announceBreakerOpened = (trigger: { id: string; title: string }) => {
    log('warn', `trigger ${trigger.id} fired more than the cap in a minute and was disarmed`);
    const error = describeError(new OpenFleetError('breaker_open', `the trigger "${toSingleLineName(trigger.title)}" fired too often in a minute and was disarmed.`, { hint: 'Check what fires it, then arm it again from the Triggers screen.' }));
    bus.emit({ type: 'error', scope: 'broadcast', error });
  };
  const fireLedger = new FireLedger(db);
  const fireRetention = new FireRetention({
    ledger: fireLedger, clock: triggerClock, schedule: options.fireRetention?.schedule ?? scheduleOnRealClock, retentionDays: triggerSettings.fireRetentionDays,
    onFailure: (error) => log('warn', 'the trigger fires could not be pruned', error),
    letTheEventLoopRun: options.fireRetention?.letTheEventLoopRun,
  });
  const announceSettledFire = ({ triggerId, fireId, ledgerState, reason }: SettledFire) => {
    bus.emit({ type: 'trigger.fired', triggerId, fireId, ledgerState, ...(reason !== undefined && { reason }) });
    systemActivity.triggerFired({ triggerId, ledgerState, reason });
  };
  const triggerEngine = new TriggerEngine({
    onSettled: announceSettledFire,
    triggers: triggerRepository, ledger: fireLedger, actions: createTriggerActions({ sessions, managers: managerRepository, clock: triggerClock, announce: (notice) => bus.emit({ type: 'notification.trigger', category: 'triggerNotice', ...notice }) }), breaker: new FireBreaker(triggerClock),
    clock: triggerClock, newId, schedule: options.triggers?.schedule ?? scheduleOnRealClock, onBreakerOpened: (trigger) => { announceBreakerOpened(trigger); cronSource.sync(trigger.id); silentRunSource.sync(trigger.id); },
  });
  const triggerCursors = new TriggerCursors(db);
  const sessionStateSource = new SessionStateSource({
    bus, sessions, managers: managerRepository, triggers: triggerRepository, cursors: triggerCursors, engine: triggerEngine, clock: triggerClock, schedule: options.triggers?.schedule ?? scheduleOnRealClock,
  });
  const tableSource = new TableSource({
    stores: storeRepo, triggers: triggerRepository, cursors: triggerCursors, engine: triggerEngine, sessions, ledger: fireLedger,
    schedule: options.triggers?.schedule ?? scheduleOnRealClock, onOfferSuppressedByCause: (triggerId) => systemActivity.triggerOfferSuppressed({ triggerId }),
  });
  const cronSource = new CronSource({ triggers: triggerRepository, cursors: triggerCursors, engine: triggerEngine, clock: triggerClock, schedule: options.triggers?.schedule ?? scheduleOnRealClock });
  const silentRunSource = new SilentRunSource({
    sessions, managers: managerRepository, triggers: triggerRepository, engine: triggerEngine, ledger: fireLedger, clock: triggerClock,
    schedule: options.triggers?.schedule ?? scheduleOnRealClock, onOfferSuppressedByCause: (triggerId) => systemActivity.triggerOfferSuppressed({ triggerId }),
  });
  const playbookRepository = new PlaybookRepository(db);
  const playbooks = new PlaybookService({ db, repository: playbookRepository, versions: new PlaybookVersionRepository(db),secretRefs: new SecretRefRepository(db), projectExists: (projectId) => projects.get(projectId) !== undefined, clock: () => new Date().toISOString(), newId });
  const playbookRuns = new PlaybookRunRepository(db);
  const scriptLocator = new ScriptLocator(options.playbooks?.scriptRoots ?? playbookSettings.scriptRoots);
  const playbookApprovals = new PlaybookApprovals({ repository: playbookRepository, locator: scriptLocator, clock: () => new Date().toISOString() });
  const playbookRunner = new PlaybookRunner({
    playbooks, approvals: playbookApprovals, runs: playbookRuns, secrets, clock: () => new Date().toISOString(), newId,
    limits: { maxStepExecutions: options.playbooks?.maxStepExecutions ?? MAX_STEP_EXECUTIONS_PER_RUN, maxConcurrentRuns: options.playbooks?.maxConcurrentRuns ?? MAX_CONCURRENT_RUNS, maxRunsNeedingReview: options.playbooks?.maxRunsNeedingReview ?? MAX_RUNS_NEEDING_REVIEW },
    observer: { runStarted: (run) => systemActivity.playbookRunStarted(run), runEnded: (run) => systemActivity.playbookRunEnded(run) },
  });
  playbookRunner.recover();
  const server = await startServer({ ...config, triggers, triggerFires: fireLedger, playbooks, playbookRunning: { approvals: playbookApprovals, runner: playbookRunner, runs: playbookRuns }, secrets: { service: secrets, nonces: secretNonces }, activity: { recorder: activity, reader: activityRepository }, e2eRoutes: config.e2eEnabled, degraded, commandPolicy, commandPolicyAdmin: { policy: commandPolicyService, denials: denialJournal }, diagnostics, managerBase, sessions, approvals, managers, pulseScheduler, bus, modelTable, modelConfigPath, notes, noteRepo, docs, docsRoot, stores, storeRepo, projects, projectService, worktrees, governanceQueue, escalations, handoff, stopRefusal, sessionStartContext, handoverLedger, contextNotice, todos, silentBlocks, workingStates, workingStateMaxAgeMinutes: workingStateSettings.maxAgeMinutes, reviewFindings, usageLedger, usageIngestion, mcp: createMcpHandler({ triggers, triggerFires: fireLedger, playbooks, secrets, activity, askUserGate, criteria, escalations, arbiters, scheduledEvents, ciWatch, github: githubReader, projectProfile: new ProjectProfileBootstrap({ db, stores, storeRepo, notes, managers, governanceQueue }), reviewFindings, ticketPattern: findingsGateSettings.ticketPattern, managerBase: shippedManagerBase, baseNotReadEnforcement: options.baseNotReadEnforcement, noteNotReadEnforcement: options.noteNotReadEnforcement, denialJournal, managerDenials, knowledgeSearch, governanceQueue, sessions, approvals, managers, pulseScheduler, modelTable, stores, storeRepo, notes, noteRepo, docs, projects, workingStates, worktreesRoot: config.worktreesRoot }) });
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
    scheduledEvents.stop();
    sessionStateSource.stop();
    tableSource.stop();
    cronSource.stop();
    silentRunSource.stop();
    triggerEngine.stop();
    await playbookRunner.stop();
    fireRetention.stop();
    childSilence.stop();
    arbiters.stop();
    await ciWatch.stop();
    childAutoRestarter.stop();
    idleChildWatcher.stop();
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
    systemActivity.daemonStarted(DAEMON_VERSION);
    // Resuming writes a new state time: the source reads the episodes a killed daemon left before that.
    const sessionsBeforeResume = sessions.list();
    await sessions.resumeAll({ onResumed: (session) => systemActivity.sessionResumed(session, lineageRootIdOf(sessions, session)) });
    arbiters.recover();
    triggerEngine.recover();
    await fireRetention.forgetOldEvents();
    fireRetention.start();
    sessionStateSource.start({ sessionsBeforeResume });
    tableSource.start();
    cronSource.start();
    silentRunSource.start();
    childSilence.restore();
    pulseScheduler.start();
    scheduledEvents.start();
    sleepHandoff.start();
    ciWatch.start();
    idleChildWatcher.start();
  } catch (error) {
    await closeWithin({ timeoutMs: REFUSED_BOOT_CLOSE_TIMEOUT_MS, close });
    throw error;
  }

  return { server, db, degraded, stores, askUserGate, criteriaStatusGuard, governanceQueue, scheduledEvents, ciWatch, triggerEngine, harnesses, secrets, playbookRunner, secretChannel, close };
}
