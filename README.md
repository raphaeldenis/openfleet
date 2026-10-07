# OpenFleet

Scape-compatible session tools include `get_session_card` and `message_argus`; see [session MCP aliases](docs/mcp-session-aliases.md) for fields, target resolution and authorization.

Table MCP reads include `describe_data_store`, `query_data_store`, and `get_data_store`. `get_data_store` returns projected schema and a page of rows ordered by update time descending, then binary row id ascending. It accepts `store`, optional `columns` (ids or display names), `limit` (default 100, 1–1000), and `offset` (default 0). Read `totalRowCount` for the table size and `next_offset` to continue; `truncated` means the 1 MiB JSON budget cut the page. A schema or first row exceeding that budget returns `invalid_body`.

Open-source desktop workspace for fleets of AI coding agents: sessions in git worktrees, manager agents with a pulse, mission notes, tables, triggers and human governance.

Status: phase 1 (foundation). See `docs/` for the phase smoke checklist; design lives in the author's superpowers folder for now.

## Sleep protection

On macOS, the daemon prevents idle system sleep while any live child or manager is `generating`. It shares one `/usr/bin/caffeinate -i -w <daemonPid>` helper across the fleet and releases it when no session generates. The display can sleep; closing the lid, explicit sleep and a critical battery can still suspend the Mac. A silent session that remains `generating` keeps the assertion even when it needs attention, so this can consume battery for a long time.

The daemon checks for long timer interruptions every five seconds. After a possible resume, it gives generating sessions 120 active seconds to show a current hook or advancing transcript. PTY redraws alone are weak evidence. A session without strong progress gets an orthogonal `runtimeAttention` field in REST, WS and MCP; its manager receives a coalesced queued notification. The daemon never kills or restarts a session based on silence. Timer drift is a suspicion, not an OS-confirmed wake, and a long silent tool can trigger an alert.

Set `"power": { "preventIdleSleepWhileGenerating": false }` in the daemon home's `config.json` and restart the daemon to opt out. The default is enabled on macOS and disabled elsewhere. Post-resume health checks remain active when protection is disabled. A helper failure reports `power_assertion_unavailable` through daemon diagnostics. Desktop attention cards and a live settings toggle are a separate increment. See [the sleep guard contract](docs/sleep-guard.md).

## Todos tab

The daemon reads a session's todo list from the Claude CLI's task tools (`TaskCreate`, `TaskUpdate`, `TaskList`). The `PostToolUse` hook is the primary source: each call updates the list as it happens, and known secret formats are masked before the text leaves the daemon. The session transcript repairs what the hooks missed (daemon restart, dropped hook) with a read window of at most 64 MiB.

Limits you can hit:
- Lists live in memory only: the last 50 closed sessions keep their list until the daemon restarts.
- A manager shows its direct children only, not grandchildren. The panel lists at most 20 children: closed children with unfinished work first, then open ones, then the other closed ones, displayed open first. The sum counts every child, and the `N more children not shown` line says how many hidden ones are unfinished.
- The panel shows up to 100 rows per list while counts cover up to 500 tasks.
- After a resume, rows rebuilt from history read `from history, not confirmed yet` until the agent names them again or lists its tasks.

## Reopen fresh

`POST /api/sessions/:id/reopen` with `{"mode": "fresh"}` relaunches a closed session of any role on a new conversation, in the same worktree and under the same identity. A manager gets its mission as the first prompt. Any other session gets the brief it was created with, stored as typed in `sessions.seeded_prompt` (plaintext, like the other tables, never returned by REST, WS or MCP). The handoff block merged into a brief at creation is not stored, so it is not replayed. A session created without a brief, or before the column existed, starts with no prompt, and the terminal says so; a stored brief above 64 KiB is not replayed either, and the terminal says that instead. A brief above 64 KiB is refused at creation with `invalid_body`. Only a fresh reopen replays a brief: a plain resume, or a relaunch after a lost conversation, never does for a non-manager. Its queued `[pulse]` lines from the daemon are dropped; messages from agents stay.

## Dev

Table columns keep their base type and can carry an optional format: `datetime` for date, `longText` or `url` for text, and `rank` for number. `add_data_store_column` accepts `format`; store descriptions and REST schemas return it. New datetime values require an ISO time with `Z` or an explicit offset and display in the local timezone. URL cells remain text; only HTTP(S) links are clickable. Rank is a plain number. Scape imports preserve these formats, including row history; reimport restores formats lost by an older import when the column has no local edits.

Edit rich cells from their grid Edit button or Row details above the history. Enter saves a single-line input; Ctrl/Command + Enter saves long text. Escape or Cancel discards the draft; Clear value saves an explicit null. Errors keep the input for retry, and successful changes refresh the selected row's history. Automatic columns and schema-mismatch rows stay read-only. Edits patch one cell; concurrent writes to the same cell use the last saved value.

Requires Node >=26 — `nvm use` in this repo picks up Homebrew's Node via `.nvmrc` (`system`); on a shell where nvm's `default` alias points elsewhere, prefix commands with `PATH="/opt/homebrew/bin:$PATH"` instead of changing the global alias.

    pnpm install
    pnpm test
    pnpm typecheck
    pnpm --filter @openfleet/desktop test
    pnpm e2e              # headless Playwright, fake harness, no Claude cost
    pnpm dev:core          # daemon on 127.0.0.1:7331
    pnpm dev               # daemon + Tauri window

`pnpm e2e` starts its daemon on a fresh `OPENFLEET_HOME` (`$TMPDIR/of-e2e-XXXXXX`) created once per run and removed when the run ends, so a database migrated by another branch never leaks into it. It picks two free ports at run time (daemon and web), so it is safe to run next to `pnpm dev` on 7331/1420 (and in parallel with another e2e run). `OPENFLEET_E2E_PORTS=<webPort>,<daemonPort>` pins them for a deterministic run. The daemon accepts the e2e web origin through `OPENFLEET_ALLOWED_ORIGINS` (comma-separated `http://localhost:<port>`-style loopback origins; anything else is ignored).

When 7331 is taken, `pnpm dev:core` listens on a free port instead and prints the URL to open the web app on it (`http://localhost:1420/?daemon=http://127.0.0.1:<port>`; only loopback http origins are accepted). An explicit `OPENFLEET_PORT` is never replaced. The Tauri window (`pnpm dev` / `tauri dev`) keeps 7331 and 1420: its dev URL, CSP and daemon probe are fixed, and so is the packaged app, which reuses a daemon on 7331.

Build budget: the production initial bundle measures about 425 kB (warning at 470 kB, error at 600 kB, set in `apps/desktop/angular.json`). Schemas import zod as `import * as z from 'zod'` so the bundler drops its unused locales and JSON-schema code; `import { z } from 'zod'` ships all of it (+330 kB).

Once a packaged app runs on `~/.openfleet` and port 7331, start dev daemons on their own home and port: `OPENFLEET_HOME=~/.openfleet-dev OPENFLEET_PORT=7332 pnpm dev:core`. A dev daemon that migrates the packaged app's database makes the packaged app refuse to boot. The packaged app reuses any daemon it finds on 7331.

### Build the dmg

    rustup target add x86_64-apple-darwin   # once, for the Intel dmg
    pnpm build:dmg                          # Apple Silicon (default)
    pnpm build:dmg --target x86_64-apple-darwin   # Intel
    pnpm build:dmg:all                      # both (Intel first, Apple Silicon last)

`scripts/release/build-local.sh` fetches the pinned official Node binary (`scripts/release/node-version.txt`, checked against nodejs.org's `SHASUMS256.txt`, cached after the first run), bundles the daemon, runs `tauri build` and prints the dmg path (`apps/desktop/src-tauri/target/<target>/release/bundle/dmg/OpenFleet_<version>_aarch64.dmg` or `..._x64.dmg`). Two separate dmgs, one per architecture (not universal): each ships its own Node sidecar and only its own node-pty prebuild, and the build refuses a node-pty prebuild missing or built for the other CPU. It needs the Rust target of the chosen architecture (`rustup target list --installed`). The resources/daemon folder holds the bundle of the last target built, which is the Apple Silicon one after `pnpm build:dmg:all`. Ad-hoc signed, not notarized, with no updater.

`tauri-build` requires the Node sidecar and the daemon bundle to exist, so on a fresh clone (or a CI runner) run both before any `cargo` or `tauri` command; `pnpm build:dmg` does it for you:

    node scripts/release/fetch-node.mjs                # [<version>] [<target>]
    pnpm --filter @openfleet/core bundle                # [--target <target>]

Install: open the dmg, drag `OpenFleet.app` to `/Applications`, launch. A dmg built and kept on the same Mac carries no quarantine flag, so Gatekeeper stays silent. The app starts its own daemon on port 7331 (it reuses one already answering there), and closing the window keeps the app and the daemon running; the Dock icon shows the window again. **Quit** (Cmd+Q) stops the daemon (SIGTERM, then SIGKILL after 12 s) and sessions resume on the next launch. To update, quit the app and drag the new `.app` over the old one.

On another Mac (AirDrop, browser or Messages add the quarantine flag) Gatekeeper refuses the unsigned app once: right-click the app and choose Open (on macOS 15 then System Settings, Privacy & Security, Open Anyway), or clear the flag:

    xattr -dr com.apple.quarantine /Applications/OpenFleet.app

### Version

`apps/desktop/src-tauri/tauri.conf.json` is the single source of the app version. `node scripts/release/set-version.mjs <semver>` writes it and every copy (`Cargo.toml`, `Cargo.lock`, the three `package.json`). Unlike the spec's `cargo update -p app`, it edits the app crate's `Cargo.lock` entry directly, so it works offline and without cargo. `node scripts/release/prepare.mjs <semver>` prepares a whole release (bump, checks, release notes stub, next git commands, never commits or pushes); the full local flow is in [RELEASING.md](RELEASING.md).

### Architecture checks

`pnpm arch` runs [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) (`.dependency-cruiser.cjs`) over `packages/core/src`, `packages/shared/src` and `apps/desktop/src`; it takes about a second. It is the first step of the pre-push hook and runs in CI. Test files (`*.test.ts`, `*.spec.ts`, testkits, fixtures, `__testing__/`) are exempt from the layering rules.

| Rule | Forbids |
| --- | --- |
| `no-circular-dependencies` | import cycles |
| `no-unresolvable-imports` | an import the resolver cannot follow |
| `shared-never-imports-node-builtins`, `shared-imports-only-zod` | `packages/shared` importing anything but zod (it ships to the browser) |
| `core-never-imports-desktop`, `desktop-never-imports-core` | the daemon and the app importing each other (only `@openfleet/shared` is common) |
| `packages-are-imported-through-their-entry-point` | importing another package's `src/` files instead of its entry point |
| `only-the-daemon-wires-the-api` | any core file but `daemon.ts` / `main.ts` importing `api/` |
| `only-the-harness-folder-touches-the-claude-cli` | any core file but `harness/`, `daemon.ts` / `main.ts` importing `harness/claudeCli/` (the adapter of the `harness.ts` port) |
| `design-system-is-a-leaf` | `app/design/` importing the rest of the app |
| `app-services-import-no-feature` | `app/core/` importing a feature or `shell/` |
| `features-never-import-the-shell` | `design/`, `core/` or a feature importing `shell/` |
| `production-code-never-imports-test-helpers` | production code importing test code |

A violation reads `error <rule>: <importing file> → <imported file>`; the rule's `comment` in `.dependency-cruiser.cjs` gives the reason. Fix the import rather than the rule.

The repo has no known violation: `.dependency-cruiser-known-violations.json` (`--ignore-known`) is empty and any violation fails. A baseline entry is debt, and it only shrinks: when you fix a listed violation, regenerate it with `pnpm exec depcruise packages/core/src packages/shared/src apps/desktop/src --config .dependency-cruiser.cjs --output-type baseline --output-to .dependency-cruiser-known-violations.json`; `scripts/arch.test.ts` fails while the file lists an entry that no longer occurs. Never regenerate it to admit a new violation. Known debt without a rule: the desktop features import each other in cycles (sessions, inbox, managers).

### Pre-push hook

`pnpm install` installs a husky `pre-push` hook (`scripts/pre-push.sh`) that runs what CI runs: `pnpm arch`, `pnpm typecheck`, `pnpm test`, `pnpm --filter @openfleet/desktop test`, stopping at the first failure. It also re-runs the core tests without `claude` in `PATH` (CI has none; skipped when `claude` is not installed), runs blocking `cargo test --lib` with the exact `Cargo.toml` Rust version and advisory `cargo +stable clippy --all-targets` when the push touches `apps/desktop/src-tauri`, and runs the e2e when it touches `apps/desktop/src`, `packages/core/src/api` or `packages/shared/src` (on free ports, whatever your dev server holds; `OPENFLEET_PREPUSH_E2E=1` forces it, `=0` skips it). `OPENFLEET_PREPUSH_DRYRUN=1 sh scripts/pre-push.sh` lists the steps without running them. It puts `/opt/homebrew/bin` first in `PATH` when present and refuses a Node older than 26.

The e2e runs automatically when the pushed range touches `apps/desktop/src`, `packages/core/src/api` or `packages/shared/src`, on free ports picked at run time; `OPENFLEET_PREPUSH_E2E=1 git push` forces it, `OPENFLEET_PREPUSH_E2E=0` skips it.

Cost: the claude-free step runs the core tests a second time (about 35 s more). Cargo is skipped locally with a notice when it is not installed; CI always runs it. When Cargo is present, the hook requires rustup and installs the test and pinned Clippy toolchains when needed. Both use `--locked` and `TAURI_CONFIG='{"bundle":{"externalBin":[],"resources":[]}}'` to check Rust without packaging the Node sidecar or daemon. Packaging builds still need both inputs.

CI runs Rust in a separate macOS job, in parallel with JavaScript tests and e2e, with a 30-minute timeout. It caches Cargo downloads and build outputs by OS, architecture, Rust 1.88.0 and `Cargo.lock`, with a restore prefix that omits the lock hash. Only successful runs on `main` save a missing cache entry; PRs restore it without saving their own entry. Each run logs the additional Rust job seconds and runner minutes, plus the cache hit, in its log and job summary; the Actions job duration includes checkout and cache upload too. The declared minimum Rust version is 1.88.0: the committed lock contains dependencies requiring it, so 1.77.2 cannot compile that lock.

Clippy is blocking in both CI and the hook: all Tauri targets run with `-D warnings` on the exact Rust 1.99.0 toolchain. This pin must be bumped deliberately in `.github/workflows/ci.yml` and `CLIPPY_RUST_VERSION` in `scripts/pre-push.sh`, after checking the new diagnostics and Rust 1.88.0 compatibility. `scripts/cargo-clippy.sh` preserves the exit code, prints the warning and error diagnostic count excluding Cargo's compilation summaries, and adds the count to the CI summary. Cargo tests remain blocking on Rust 1.88.0.

#### Hook / CI parity

| CI step | Hook | Difference |
| --- | --- | --- |
| `pnpm arch`, `pnpm typecheck`, `pnpm test`, `pnpm --filter @openfleet/desktop test` | always | none |
| `pnpm --filter @openfleet/desktop build` (production build: budgets, AOT strict templates) | when the push touches `apps/desktop/src`, the files at the root of `apps/desktop` or `packages/shared` (about 5 s) | skipped otherwise |
| `pnpm e2e` | when the push touches `apps/desktop/src`, `packages/core/src/api` or `packages/shared/src` and the ports are free | CI always runs it |
| `cargo +1.88.0 test --lib`, `cargo +1.99.0 clippy --all-targets -- -D warnings` (both `--locked`) | when the push touches `apps/desktop/src-tauri`, if Cargo is installed | CI always runs them; tests use the declared minimum Rust version, Clippy uses an exact pin, both disable bundle inputs and block on failure |
| `pnpm install --frozen-lockfile`, `playwright install` | never | already installed locally |
| clean clone of the pushed commit | working tree | the hook fails on untracked, non-ignored files under `packages/`, `apps/`, `scripts/` (absent from CI's clone: `git add` them or list them in `.gitignore`) and warns on uncommitted tracked changes |
| macOS shared runner | your machine | timing-sensitive tests can fail on CI only |

`scripts/ci-hook-parity.test.ts` fails when `ci.yml` runs a `pnpm` command that the hook neither runs nor lists, with a reason, in its `EXCEPTIONS`. It also checks Cargo command parity, the test toolchain against `rust-version`, the exact Clippy pin and blocking arguments, failure propagation and the shared bundle-free configuration.

CI runs on `pull_request` and on pushes to `main`: a branch push with an open PR runs once. A branch pushed without a PR does not run CI; the hook has already run the same checks.

`git push --no-verify` is the only bypass. The hook path is shared by all worktrees through the common `.git/config`; each worktree needs one `pnpm install` (or `pnpm prepare`) to generate its untracked `.husky/_`.

### Autonomous Claude Code sessions (local opt-in only)

The repo ships no `.claude/settings.json` and no auto-approve hook: a clone of this public repo must not grant any agent a permission bypass by default. If you want an autonomous session in your own checkout, add your own `.claude/settings.local.json` (already gitignored) with a `permissions.defaultMode` and any `PreToolUse`/`PermissionRequest` hook you're comfortable with — it stays local to your machine and is never committed.

OpenFleet-launched `claude` sessions ignore a project's `.claude/settings.json` (and `settings.local.json`) entirely (AUD-28), so the file above has no effect on them; a per-project reconcile/import of those settings is planned (AUD-29).

Live smoke checklist (needs a real `claude` subscription, not run in CI): `docs/phase1-smoke.md`.
