# OpenFleet

Open-source desktop workspace for fleets of AI coding agents: sessions in git worktrees, manager agents with a pulse, mission notes, tables, triggers and human governance.

Status: phase 1 (foundation). See `docs/` for the phase smoke checklist; design lives in the author's superpowers folder for now.

## Todos tab

The daemon reads a session's todo list from the Claude CLI's task tools (`TaskCreate`, `TaskUpdate`, `TaskList`). The `PostToolUse` hook is the primary source: each call updates the list as it happens, and known secret formats are masked before the text leaves the daemon. The session transcript repairs what the hooks missed (daemon restart, dropped hook) with a read window of at most 64 MiB.

Limits you can hit:
- Lists live in memory only: the last 50 closed sessions keep their list until the daemon restarts.
- A manager shows its direct children only, not grandchildren. The panel lists at most 20 children: closed children with unfinished work first, then open ones, then the other closed ones, displayed open first. The sum counts every child, and the `N more children not shown` line says how many hidden ones are unfinished.
- The panel shows up to 100 rows per list while counts cover up to 500 tasks.
- After a resume, rows rebuilt from history read `from history, not confirmed yet` until the agent names them again or lists its tasks.

## Dev

Requires Node >=26 — `nvm use` in this repo picks up Homebrew's Node via `.nvmrc` (`system`); on a shell where nvm's `default` alias points elsewhere, prefix commands with `PATH="/opt/homebrew/bin:$PATH"` instead of changing the global alias.

    pnpm install
    pnpm test
    pnpm typecheck
    pnpm --filter @openfleet/desktop test
    pnpm e2e              # headless Playwright, fake harness, no Claude cost
    pnpm dev:core          # daemon on 127.0.0.1:7331
    pnpm dev               # daemon + Tauri window

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

`apps/desktop/src-tauri/tauri.conf.json` is the single source of the app version. `node scripts/release/set-version.mjs <semver>` writes it and every copy (`Cargo.toml`, `Cargo.lock`, the three `package.json`). Unlike the spec's `cargo update -p app`, it edits the app crate's `Cargo.lock` entry directly, so it works offline and without cargo.

### Pre-push hook

`pnpm install` installs a husky `pre-push` hook (`scripts/pre-push.sh`) that runs what CI runs: `pnpm typecheck`, `pnpm test`, `pnpm --filter @openfleet/desktop test`, stopping at the first failure. It also re-runs the core tests without `claude` in `PATH` (CI has none; skipped when `claude` is not installed), runs `cargo test` and `cargo clippy -- -D warnings` when the push touches `apps/desktop/src-tauri`, and runs the e2e when it touches `apps/desktop/src`, `packages/core/src/api` or `packages/shared/src` and ports 1420/7332 are free (`OPENFLEET_PREPUSH_E2E=1` forces it, `=0` skips it). `OPENFLEET_PREPUSH_DRYRUN=1 sh scripts/pre-push.sh` lists the steps without running them. It puts `/opt/homebrew/bin` first in `PATH` when present and refuses a Node older than 26.

The e2e runs automatically when the pushed range touches `apps/desktop/src`, `packages/core/src/api` or `packages/shared/src` and ports 1420 and 7332 are free; `OPENFLEET_PREPUSH_E2E=1 git push` forces it (fails on busy ports), `OPENFLEET_PREPUSH_E2E=0` skips it.

Cost: the claude-free step runs the core tests a second time (about 35 s more). Cargo is skipped with a notice when it is not installed, and the first push that touches `src-tauri` may download the Node sidecar (network) and bundle the daemon.

`git push --no-verify` is the only bypass. The hook path is shared by all worktrees through the common `.git/config`; each worktree needs one `pnpm install` (or `pnpm prepare`) to generate its untracked `.husky/_`.

### Autonomous Claude Code sessions (local opt-in only)

The repo ships no `.claude/settings.json` and no auto-approve hook: a clone of this public repo must not grant any agent a permission bypass by default. If you want an autonomous session in your own checkout, add your own `.claude/settings.local.json` (already gitignored) with a `permissions.defaultMode` and any `PreToolUse`/`PermissionRequest` hook you're comfortable with — it stays local to your machine and is never committed.

OpenFleet-launched `claude` sessions ignore a project's `.claude/settings.json` (and `settings.local.json`) entirely (AUD-28), so the file above has no effect on them; a per-project reconcile/import of those settings is planned (AUD-29).

Live smoke checklist (needs a real `claude` subscription, not run in CI): `docs/phase1-smoke.md`.
