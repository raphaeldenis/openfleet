# @openfleet/desktop

## In brief

- The OpenFleet app: an Angular 22 single-page app (`package.json:17-22`) wrapped by a Tauri 2 shell (`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml:24`). Product overview: [root README](../../README.md).
- It holds no business logic. It talks to the daemon (`packages/core`) over HTTP and WebSocket on `127.0.0.1:7331` (`src/environments/environment.ts:3`, root `README.md:17`).
- Dev server port: **1420**, not Angular's default. `pnpm start` runs `ng serve --port 1420` (`package.json:7`).
- Unit tests: `pnpm test` (`ng test`, Vitest through `@angular/build:unit-test`). E2E: `pnpm e2e` from the repo root (Playwright, own throwaway daemon).
- Commands run from `apps/desktop` unless marked "root". Node >= 26 and pnpm are required (root `package.json:7-9`).

Anything not backed by a file reference is marked `UNVERIFIED`: this guide was written by reading the code, without starting the app or running a build.

## Run in dev

| Goal | Command | Source |
| --- | --- | --- |
| Web app only | `pnpm start` (= `ng serve --port 1420`) | `package.json:7` |
| Daemon only (root) | `pnpm dev:core` | root `package.json:15` |
| Daemon + Tauri window (root) | `pnpm dev` | root `package.json:17` |
| Tauri window only | `pnpm dev:desktop` (= `tauri dev`), or `pnpm tauri dev` here | root `package.json:16`, `package.json:11` |

- `ng serve` uses the `development` configuration by default (`angular.json:61-71`). `angular.json` sets no port, so a bare `ng serve` is not pinned to 1420: use `pnpm start`.
- `tauri dev` runs `pnpm start` first (`beforeDevCommand`) and loads `http://localhost:1420` (`tauri.conf.json:8-9`). The Tauri window keeps 1420 and 7331: its dev URL and its CSP (`connect-src` on `127.0.0.1:7331`, `tauri.conf.json:23`) are fixed (root `README.md:71`).
- When 7331 is taken, `pnpm dev:core` picks a free port and prints the URL to open the web app on it, `http://localhost:1420/?daemon=http://127.0.0.1:<port>` (root `README.md:71`; the app reads `?daemon=` in `src/environments/environment.ts:69-85`).
- Tauri needs the Node sidecar and the daemon bundle on disk (`tauri.conf.json:29-30`); see root `README.md:93-96`.
- UNVERIFIED: that `pnpm start`, `pnpm dev` or the Tauri window start on this machine. None was run for this guide.

## Build

- `pnpm build` runs `ng build` (`package.json:8`), production configuration by default (`angular.json:59`). Output goes to `dist/desktop/browser` (`tauri.conf.json:7`).
- The production budget warns at 470 kB and fails at 600 kB for the initial bundle (`angular.json:39-44`).
- `pnpm watch` rebuilds with the development configuration (`package.json:9`).
- The macOS bundle targets are `app` and `dmg`, minimum macOS 14.0 (`tauri.conf.json:28,34`). The dmg is built from the repo root with `pnpm build:dmg` (root `package.json:18`; steps in root `README.md:84-98`).
- UNVERIFIED: that the build or the dmg succeeds today.

## Test

### Unit tests

- `pnpm test` runs `ng test` (`package.json:10`): builder `@angular/build:unit-test`, setup file `src/test-setup.ts`, one isolated environment per spec (`angular.json:73-78`). The runner is Vitest (`package.json:41`); the DOM is `jsdom` (`package.json:38`).
- From the root: `pnpm --filter @openfleet/desktop test` (root `README.md:64`). The pre-push hook and CI run it (root `README.md:132,146`).
- Specs sit next to the code as `*.spec.ts`. Components are tested with `@testing-library/angular` (`package.json:35`).

### End-to-end tests

- From the root: `pnpm e2e` (root `package.json:20`) = `playwright test` in this folder, with the fake harness and no Claude cost (root `README.md:65`).
- Specs are in `e2e/` (`playwright.config.ts:14`), helpers in `e2e/support/`.
- The config starts two servers per run (`playwright.config.ts:16-29`) and never reuses one already running (`reuseExistingServer: false`):
  1. the daemon, `pnpm --filter @openfleet/core exec tsx src/main.ts`, polled on `/health` (`:18-22`);
  2. the web app, `pnpm exec ng serve --port <webPort>` (`:25`).
- The daemon is throwaway. It runs on a fresh `OPENFLEET_HOME` created once per run and removed at the end, so no database from another branch leaks in (`playwright.config.ts:7,22`; root `README.md:69`). It also receives `OPENFLEET_PORT` and `OPENFLEET_ALLOWED_ORIGINS` (the web URL) and the e2e flag (`:22`).
- Ports are chosen at run time, not 7331 or 1420 (`scripts/e2e/e2ePorts.ts:25-29,40-41`). The order is: ports already announced in `OPENFLEET_E2E_API` / `OPENFLEET_E2E_WEB_URL` (`:36-38`), then the `OPENFLEET_E2E_PORTS=<webPort>,<daemonPort>` override (`:5,14-23`), then two free ports. A run is therefore safe beside `pnpm dev` and beside another e2e run (root `README.md:69`).
- UNVERIFIED: that the e2e suite passes today.

## Architecture

The app lives in `src/app/`. `app.routes.ts` lazy-loads every screen (`app.routes.ts:8-27`). Folder rules are enforced by `pnpm arch` (dependency-cruiser, `.dependency-cruiser.cjs`; root `README.md:108-128`).

| Folder | Role | May import |
| --- | --- | --- |
| `design/` | Presentational building blocks: badges, banners, chips, popover, keyboard helpers, plus the dev-only `/components` sheet (`app.routes.ts:5-7`). | Nothing else in the app. It is a leaf; it never imports `core/` (rule `design-system-is-a-leaf`, `.dependency-cruiser.cjs:107-111`). |
| `core/` | App-wide services and pure helpers: `FleetApi`, events stream, daemon status, notifications, error copy, admin token. | Not a feature, not `shell/` (rule `app-services-import-no-feature`, `:114-118`). |
| `shell/` | The app chrome: sidebar, right panel, empty and not-found pages. It composes the features. | Features, `core/`, `design/`. Nothing imports `shell/` (rule `features-never-import-the-shell`, `:121-125`). |
| `inbox/`, `managers/`, `notes/`, `onboarding/`, `projects/`, `sessions/`, `settings/`, `tables/`, `working-state/` | The feature folders (`.dependency-cruiser.cjs:29`), one per screen area. | `core/`, `design/`. |
| `testing/` | Test helpers; production code never imports them (rule `production-code-never-imports-test-helpers`, `:129`). | n/a |

Other folders:

- `src/environments/` holds the daemon URL logic (default `http://127.0.0.1:7331`, `environment.ts:3`).
- `public/` is copied as assets (`angular.json:26-31`); styles start at `src/styles.scss` and the xterm CSS (`angular.json:32-35`).
- `src-tauri/` is the Rust shell (`Cargo.toml`, library `app_lib`, `:13-15`). Window 1400x900 (`tauri.conf.json:16-17`). Sources in `src-tauri/src/` include `daemon.rs`, `notifications.rs`, `lib.rs`; the root README describes the shell as window, tray, notifications and daemon sidecar launcher (root `README.md:13`). UNVERIFIED: the behaviour of each Rust module, which this guide does not trace.
- `e2e/` holds the Playwright specs described above.

Known debt, from the root README (`README.md:128`): the feature folders import each other in cycles (sessions, inbox, managers); no rule covers it.
