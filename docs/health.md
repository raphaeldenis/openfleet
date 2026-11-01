# Daemon health

## In brief

- `GET /health` on the daemon answers without auth: `200 {ok, version, status, issues}`, or `503 {ok:false, status:"shutting_down"}` once the shutdown has begun (`packages/core/src/api/server.ts:177-182`).
- A `200` proves that the daemon process accepts HTTP requests and that its in-memory degraded registry is empty or not. It proves nothing else: the handler reads two values and nothing more (`server.ts:178-180`).
- `status: "degraded"` still comes with `200` and `ok: true` (`server.ts:175-176`). A probe that only checks the HTTP code does not see it.
- No page in this repo names Vigie or a CI/DevOps watcher as a consumer of `/health`. Supervision targets are listed in [Supervision targets](#supervision-targets).
- Publication, signing and notarization of the app (RELEASE01) is an open decision of Raphaël. This page does not settle it.

## The endpoint

| Item | What the code does today | Source |
| --- | --- | --- |
| Route | `GET /health`, registered before the API routes | `packages/core/src/api/server.ts:177` |
| Auth | none: it is an unauthenticated readiness probe for CI and e2e `webServer` checks, which run before the admin token is known | `server.ts:173` |
| Address | the daemon binds `127.0.0.1`; the port is `OPENFLEET_PORT`, default `7331` | `packages/core/src/config.ts:27-28` |
| `version` | the version injected at bundle time, or `dev` when run from sources | `packages/core/src/version.ts:6` |
| `status` | `ok` when the degraded registry lists no issue, else `degraded`; `ok` when the daemon has no registry | `server.ts:178-179`, `packages/core/src/process/degradedRegistry.ts:106-108` |
| `issues` | the number of issues in the registry. The issues are counted, not listed, because the route has no auth | `server.ts:175-178` |

### Answers

| Situation | HTTP | Body | Test |
| --- | --- | --- | --- |
| Nothing is wrong | 200 | `{ ok: true, version, status: "ok", issues: 0 }` | `packages/core/src/api/rest.test.ts:80-84` |
| One or more issues | 200 | `{ ok: true, version, status: "degraded", issues: N }` | `packages/core/src/api/degradedHealth.test.ts:71-79` |
| Shutdown has begun | 503 | `{ ok: false, status: "shutting_down" }`, no error envelope | `rest.test.ts:86-93` |
| Shutdown has begun and the daemon is also degraded | 503 | same `shutting_down` body | `degradedHealth.test.ts:96-104` |
| The server is closing | 503 or a refused connection, never a hang | | `degradedHealth.test.ts:106-117` |

The shutdown flag is set by `close()` in the daemon before the sessions close, while the port is still bound (`packages/core/src/daemon.ts:384-385`, comment at `server.ts:249`). A launching app uses the 503 to avoid reusing a dying daemon (`rest.test.ts:86`; probe in `apps/desktop/src-tauri/src/daemon.rs:136-147`).

### What `degraded` means

The registry holds one issue per code. The codes are `uncaught_exception`, `db_stuck`, `hook_fail_open`, `docs_folder_unreadable`, `ws_broadcast_failed` and `power_assertion_unavailable` (`packages/shared/src/daemonIssues.ts:2`).

- `db_stuck` is marked by a write that fails and clears on the first write that succeeds; `/health` goes back to `ok` (`packages/core/src/api/dbStuck.test.ts:106-151`).
- `hook_fail_open` is marked by three failing-open hook answers within five minutes and clears after five clean minutes (`degradedRegistry.ts:6-8, 24, 94-99`). The expiry is evaluated when the registry is read, and a sweep reads it on a timer (`packages/core/src/daemon.ts:381-382`).
- `uncaught_exception` keeps `/health` at `200 ok` with `status: degraded` and leaves one owner-only crash file in `<home>/crashes`. A second escaped exception within a minute exits the process with code 2 (`packages/core/src/bootProcess.degraded.probe.test.ts:63-88`).
- The detail of each issue (code, since, message, ref, count) is not on `/health`. It is in the snapshot sent over the WebSocket (`daemonIssues`, `dbStuck.test.ts:116-126`) and in the daemon log, which carries the same ref. `/health` does not list it to an unauthenticated caller (`degradedHealth.test.ts:88-94`).

## What `/health` proves

- The daemon process is up, bound to its port and serving HTTP (a `200` from the handler above).
- Which daemon version answers: the app reads `version` from the one `/health` request made at boot and warns when it differs from the app version (`apps/desktop/src/app/app-root.version-banner.spec.ts:13-46`).
- Whether the daemon has recorded a degraded issue since it started or since the last clear (`status`, `issues`).
- That the daemon has not begun to shut down (`200` rather than `503`).

## What `/health` does not prove

Each point follows from the handler: it reads the registry and the shutdown flag (`server.ts:177-182`).

- It does not open the database, read or write a row. A stuck database shows only after a write has failed (`dbStuck.test.ts:106-114`).
- It does not check that a session can start: the harness binary check runs at spawn, not here ([launch health](launch-health.md)).
- It does not check the WebSocket, the MCP endpoint, the hooks or any authenticated route. The server routes `/hooks` and `/mcp` separately (`server.ts:208-214`).
- It carries no uptime, latency, load or session count.
- It does not prove the app works. The desktop app reads `ok` and `version` from the body and treats a missing `ok: true` as a daemon that does not answer (`apps/desktop/src/app/core/fleet-api.service.ts:109-110`).
- A passing `/health` on `127.0.0.1:7331` can be an older or other daemon. The packaged app reuses any daemon it finds on 7331 ([README.md](../README.md#dev)).

## Who reads it today

| Reader | How | Source |
| --- | --- | --- |
| Tauri shell | polls `GET /health` every 250 ms until a `200`; keeps polling in a slow state after the ready timeout; a `503` makes it wait before starting a new daemon | `apps/desktop/src-tauri/src/daemon.rs:26, 130-171, 462-475` |
| Angular app | one request at boot (aborted after 5 s), polled on the onboarding daemon step; a `503` keeps the user on that step | `fleet-api.service.ts:20, 109-110`, `apps/desktop/src/app/onboarding/onboarding.hostile.spec.ts:130-170` |
| Playwright e2e | waits on `${daemonUrl}/health` before the tests | `apps/desktop/playwright.config.ts:20` |
| Release bundle test | fetches `/health` on a bundled daemon | `scripts/release/bundle.test.ts:581` |
| Cutover runbook | step 10 checks `GET http://127.0.0.1:7331/health` for HTTP 200 on two starts | `docs/cutover-runbook.md:136` |

## Supervision targets

What the repository says about Vigie and the CI/DevOps watcher:

- **Vigie.** The repository has no mention of Vigie (no file, script, doc or test). Any Vigie target for OpenFleet is UNVERIFIED here; it has to come from the Vigie side.
- **CI/DevOps watcher.** No document in the repository describes a watcher that reads `/health`. `daemon.ts:376` wires a `CiWatchService` that watches pull requests through `gh`; the repository does not say it is the watcher meant here, so the link is UNVERIFIED.
- **What a supervisor can use today, from the code above.** `GET http://127.0.0.1:<OPENFLEET_PORT>/health` on the machine that runs the daemon. Failure cases: no connection (daemon not running), `503` (shutting down), a `200` whose body lacks `ok: true`. Warning case: `status: "degraded"` or `issues > 0`. The loopback binding means a supervisor on another host cannot reach it (`config.ts:27`).
- **Polling interval, alert thresholds, owner of the alert.** Not defined in the repository. To be decided by Raphaël.

## Related checks outside `/health`

- Quit stops the daemon: `lsof -nP -iTCP:7331 -sTCP:LISTEN` is empty within 12 s (`RELEASING.md:64`).
- Live smoke checks that need a real `claude`: [phase1-smoke.md](phase1-smoke.md).
- Daemon diagnostics route `GET /api/diagnostics` exists only when the daemon is wired with a diagnostics source (`server.ts:115-116, 184`). It is authenticated; its content is not described here (UNVERIFIED).

## Open decision: RELEASE01

Publication, signing, notarization and the update server are not decided. `RELEASING.md:5` and `RELEASING.md:53` carry `TODO: decision pending (see RELEASE01)`. The released build today is a local, ad-hoc signed dmg (`RELEASING.md:3`). This is a decision for Raphaël; this page records it as open and does not choose.

## UNVERIFIED

- Any Vigie target, and whether the `CiWatchService` is the CI/DevOps watcher.
- The content of `GET /api/diagnostics`.
- `/health` on `main` with migration 061: `docs/cutover-runbook.md:136` marks it UNVERIFIED.
- Polling interval and alert rules for a supervisor.
