import { startServer } from './api/server.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { EventBus } from './events/eventBus.js';
import { ApprovalService } from './governance/approvalService.js';
import { ClaudeCliHarness } from './harness/claudeCli/claudeCliHarness.js';
import { FakeHarness } from './harness/fakeHarness.js';
import { createMcpHandler } from './mcp/mcpServer.js';
import { SessionRepository } from './sessions/sessionRepository.js';
import { SessionService } from './sessions/sessionService.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
new SessionRepository(db).closeAllOpen(new Date().toISOString());
const bus = new EventBus();
const baseUrl = `http://${config.host}:${config.port}`;
const sessions = new SessionService({ db, bus, harnesses: [new ClaudeCliHarness(), new FakeHarness()], baseUrl, worktreesRoot: config.worktreesRoot });
const approvals = new ApprovalService({ db, bus });

const server = await startServer({ ...config, sessions, approvals, bus, mcp: createMcpHandler({ sessions, worktreesRoot: config.worktreesRoot }) });
console.log(`openfleet core listening on ${server.url} (home: ${config.home})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => { await server.close(); process.exit(0); });
}
