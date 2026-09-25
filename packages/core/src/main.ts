import { startServer } from './api/server.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { EventBus } from './events/eventBus.js';
import { ApprovalService } from './governance/approvalService.js';
import { ClaudeCliHarness } from './harness/claudeCli/claudeCliHarness.js';
import { FakeHarness } from './harness/fakeHarness.js';
import { createMcpHandler } from './mcp/mcpServer.js';
import { SessionService } from './sessions/sessionService.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
const bus = new EventBus();
const baseUrl = `http://${config.host}:${config.port}`;
const sessions = new SessionService({ db, bus, harnesses: [new ClaudeCliHarness(), new FakeHarness()], baseUrl, worktreesRoot: config.worktreesRoot });
const approvals = new ApprovalService({ db, bus });

// The server must be listening before any resumed CLI can POST its first hook — resuming first risks a
// fast process hitting a port nothing is serving yet.
const server = await startServer({ ...config, sessions, approvals, bus, mcp: createMcpHandler({ sessions, worktreesRoot: config.worktreesRoot }) });
console.log(`openfleet core listening on ${server.url} (home: ${config.home})`);

await sessions.resumeAll();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await sessions.closeAll();
    await server.close();
    process.exit(0);
  });
}
