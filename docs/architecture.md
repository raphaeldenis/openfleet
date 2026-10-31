# Architecture overview

## En bref

OpenFleet is a desktop app that runs several AI coding agents (Claude Code sessions) side by side. Two programs cooperate on your Mac. The **daemon** is a background Node program that starts the agents, keeps all state in one local database and enforces the rules. The **desktop app** is the window you look at; it holds no business logic and only talks to the daemon over `127.0.0.1:7331`. A small **shared** package holds the message formats both sides agree on. Each agent reports what it does to the daemon through hooks and asks it for tools through MCP.

Every claim below cites `file:line` on `main` (a43c0797). `UNVERIFIED` marks what the code read here does not settle. For features, read the linked docs; this page does not repeat them.

## Map

```
 Tauri shell (Rust)  ──starts──▶  daemon (Node 26, packages/core)  ◀──hooks / MCP──  claude CLI in a PTY
   │ hosts                           │ REST + WebSocket on 127.0.0.1:7331              (one per session,
   ▼                                 ▼                                                  in a git worktree)
 Angular app  ──REST + WS ticket──▶ services ─▶ SQLite (openfleet.db)
 (apps/desktop)                      both sides import only packages/shared (zod)
```

| Part | Where | Role |
| --- | --- | --- |
| Daemon | `packages/core` | Sessions, worktrees, notes, tables, triggers, governance (`README.md:11`). |
| Shared | `packages/shared` | Wire schemas and pure helpers; imports nothing but zod (`README.md:12`, `.dependency-cruiser.cjs:50-60`). |
| App | `apps/desktop/src` | Angular UI; folders `core design inbox managers notes onboarding projects sessions settings shell tables working-state` under `src/app`. |
| Tauri shell | `apps/desktop/src-tauri` | Window, native notifications, daemon lifecycle (`lib.rs:153-171`). A tray is named in `README.md:13`; no tray code was found in `lib.rs`: UNVERIFIED. |

## Daemon (`packages/core`)

- **Entry.** `main.ts:1-13` runs the `import` CLI when `argv[2]` is `import`, else loads `daemonEntry.ts`, which calls `startDaemon(loadConfig())` (`daemonEntry.ts:16`) and installs the shutdown handler (`:23`).
- **Config.** Host is always `127.0.0.1`, port `OPENFLEET_PORT` or 7331, data in `OPENFLEET_HOME` (default `~/.openfleet`), database `openfleet.db`, admin token in `admin.token` (`config.ts:27-34`).
- **Composition root.** `startDaemon` (`daemon.ts:192`) opens the database (`:196`), creates the `EventBus` (`:197`), builds every service by hand, then calls `startServer` (`:377`). Only `daemon.ts` and `main.ts` may import `api/` (`.dependency-cruiser.cjs:90-94`; rule table in `README.md:108-128`).
- **Boot order.** Sweeps stale launch dirs, starts the docs-folder watcher, resumes every session (`sessions.resumeAll()`), then starts the pulse, scheduled-event, CI-watch and idle-child timers (`daemon.ts:412-422`). A throw closes what started and refuses the boot (`:423-426`).
- **Shutdown.** `close()` stops the timers, closes sessions, then the server (`daemon.ts:384-407`); `GET /health` answers 503 `shutting_down` meanwhile (`server.ts:177-182,250`).
- **Feature folders** under `packages/core/src`: `sessions managers governance escalation policy review usage notes stores projects worktrees knowledge workingState todos power diagnostics process db mcp api harness`. Their contracts are in the docs below.

## Harness

- The port is `Harness` (`harness/harness.ts:52`): `start(launch)` returns a handle with `write`, `resize`, `kill`, `onData`, `onExit` (`:34-45`).
- The adapter `ClaudeCliHarness` spawns the `claude` CLI in a PTY with node-pty (`harness/claudeCli/claudeCliHarness.ts:3,56`); only `harness/`, `daemon.ts` and `main.ts` may import it (`README.md:120`).
- `FakeHarness` is added only when `OPENFLEET_E2E=1` (`daemon.ts:200`).
- Launch config: per session, the daemon writes CLI settings with a hook for each of `SessionStart SessionEnd UserPromptSubmit PreToolUse PostToolUse PermissionRequest Notification Stop` (`shared/src/hooks.ts:36-38`, `launchConfig.ts:73-76`) and an MCP server entry `openfleet` with a bearer token (`launchConfig.ts:36-39`). `SessionStart` goes through `curl` because the CLI drops http hooks for that event (`launchConfig.ts:79-87`).

## Flows

**Session.** `POST /api/sessions` (`restHandlers.ts:66`) calls `SessionService.create` (`sessionService.ts:536`) or `createInWorktree` (`:595`), which starts the harness. Messages go through `sendMessage` (`:651`), `reopen` (`:855`) resumes or restarts a closed session, `close` (`:1448`) ends it, and `resumeAll` (`:1611`) relaunches open ones at boot. Worktrees: [worktrees](worktrees.md). Launch failures: [launch health](launch-health.md).

**Hooks.** The CLI POSTs to `/hooks/<token>` (`server.ts:65,210-214`). An unknown token gets `200 {}` (`:134-135`). The handler parses the event (`hooksHandler.ts:117`) and, depending on its name, applies the command policy to `PermissionRequest` and `PreToolUse` (`:123-127`), may refuse a `Stop` (`:128`) and builds context for `SessionStart` (`:131`); every other case answers `{}` (`:142`). Rules: [command policy](command-policy.md), [governance queue](governance-queue.md), [escalation](escalation.md), [usage ledger](usage-ledger.md).

**WebSocket.** The app asks `POST /api/ws-ticket` (`restHandlers.ts:51`), then opens `/ws?ticket=…`; the ticket is single use and the origin must be allowed (`wsHandler.ts:187-197`, `fleet-events.service.ts:229-235`). A new connection first gets a `snapshot` of sessions, approvals, managers and more (`wsHandler.ts:157-168`); afterwards every `EventBus` event is broadcast (`:128`).

**SSE.** No server-sent-events endpoint exists: `event-stream` and `EventSource` appear only in three test files under `packages/core/src`.

**Auth.** Routes under `/api/` need `Authorization: Bearer <admin token>` (`server.ts:220-221`). `/health` is open (`:177`). `/mcp` needs the session's MCP token (`:147-148,216`). Inside Tauri the app reads the admin token through the `read_admin_token` command (`tauri-admin-token.ts:11`, `admin_token.rs:9-10`).

**MCP.** `/mcp` is a streamable-HTTP transport (`mcp/mcpServer.ts:3,116`); `daemon.ts:377` hands it the services. The tool contract carries `CONTRACT_VERSION = 15` (`shared/src/mcpContract.ts:2`). See [MCP contract](mcp-contract.md), [contract 15](contract-15.md), [session aliases](mcp-session-aliases.md), [note writes](note-writes.md).

**Database.** `node:sqlite` `DatabaseSync` (`db/database.ts:3,17`) with WAL, foreign keys on and a 5 s busy timeout (`:77`). Migrations are `db/migrations/NNN_*.sql`, 001 to 062 (`062_child_silence_checks.sql`), recorded in `schema_migrations` (`migrate.ts:244`), never run inside their own transaction (`:252`), and refused if an applied file was edited (`:217-222`). Pending migrations trigger a backup first; checklist and rollback: [db/README.md](../packages/core/src/db/README.md).

## Desktop app and Tauri

- Tauri loads `dist/desktop/browser` in production and `http://localhost:1420` in dev (`tauri.conf.json:7-8`), and bundles a Node sidecar plus the daemon bundle (`:29-30`).
- On setup it calls `daemon::start` (`lib.rs:166`): reuse a daemon already answering `GET /health` on `127.0.0.1:7331` (`daemon.rs:18,398`), else spawn the sidecar. Quit sends SIGTERM, then SIGKILL after 12 s (`daemon.rs:22,199,210`). Closing the window only hides it (`lib.rs:156-160`).
- The webview calls Tauri commands (`lib.rs:162`) such as `daemon_status` (`daemon-status.service.ts:41`); everything else goes over REST and WebSocket (`fleet-api.service.ts`, `fleet-events.service.ts`).
- The app never imports `packages/core`, nor the reverse (`.dependency-cruiser.cjs:65-76`).

## Boundaries enforced by `pnpm arch`

[dependency-cruiser](../.dependency-cruiser.cjs) forbids cycles, `shared` importing anything but zod, core and desktop importing each other, and `app/design` or `app/core` importing features or the shell. Table: `README.md:112-124`. Known debt: desktop features import each other in cycles (`README.md:128`).

## Where to read next

| Topic | Doc |
| --- | --- |
| Build, run, test, pre-push hook, CI parity | [README](../README.md), [house rules](house-rules.md) |
| Terms | [GLOSSARY](../GLOSSARY.md) |
| Decisions | [ADR 0001 to 0006](adr/), for example [0003, human merge by default](adr/0003-merge-policy-human-by-default.md) |
| Release, signing, rollback | [RELEASING](../RELEASING.md), [cutover runbook](cutover-runbook.md) |
| Managers and pulse | [manager mode](manager-mode.md), [notification events](notification-events.md) |
| Power and sleep | [sleep guard](sleep-guard.md) |
| Error codes | [errors](errors.md) |
| Live smoke test | [phase 1 smoke](phase1-smoke.md) |
