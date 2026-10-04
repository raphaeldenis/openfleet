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

`apps/desktop/src-tauri/tauri.conf.json` is the single source of the app version. `node scripts/release/set-version.mjs <semver>` writes it and every copy (`Cargo.toml`, `Cargo.lock`, the three `package.json`). Unlike the spec's `cargo update -p app`, it edits the app crate's `Cargo.lock` entry directly, so it works offline and without cargo.

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

`pnpm install` installs a husky `pre-push` hook (`scripts/pre-push.sh`) that runs what CI runs: `pnpm arch`, `pnpm typecheck`, `pnpm test`, `pnpm --filter @openfleet/desktop test`, stopping at the first failure. It also re-runs the core tests without `claude` in `PATH` (CI has none; skipped when `claude` is not installed), runs `cargo test` and `cargo clippy -- -D warnings` when the push touches `apps/desktop/src-tauri`, and runs the e2e when it touches `apps/desktop/src`, `packages/core/src/api` or `packages/shared/src` and ports 1420/7332 are free (`OPENFLEET_PREPUSH_E2E=1` forces it, `=0` skips it). `OPENFLEET_PREPUSH_DRYRUN=1 sh scripts/pre-push.sh` lists the steps without running them. It puts `/opt/homebrew/bin` first in `PATH` when present and refuses a Node older than 26.

The e2e runs automatically when the pushed range touches `apps/desktop/src`, `packages/core/src/api` or `packages/shared/src` and ports 1420 and 7332 are free; `OPENFLEET_PREPUSH_E2E=1 git push` forces it (fails on busy ports), `OPENFLEET_PREPUSH_E2E=0` skips it.

Cost: the claude-free step runs the core tests a second time (about 35 s more). Cargo is skipped with a notice when it is not installed, and the first push that touches `src-tauri` may download the Node sidecar (network) and bundle the daemon.

#### Hook / CI parity

| CI step | Hook | Difference |
| --- | --- | --- |
| `pnpm arch`, `pnpm typecheck`, `pnpm test`, `pnpm --filter @openfleet/desktop test` | always | none |
| `pnpm --filter @openfleet/desktop build` (production build: budgets, AOT strict templates) | when the push touches `apps/desktop/src`, the files at the root of `apps/desktop` or `packages/shared` (about 5 s) | skipped otherwise |
| `pnpm e2e` | when the push touches `apps/desktop/src`, `packages/core/src/api` or `packages/shared/src` and the ports are free | CI always runs it |
| `pnpm install --frozen-lockfile`, `playwright install` | never | already installed locally |
| clean clone of the pushed commit | working tree | the hook fails on untracked, non-ignored files under `packages/`, `apps/`, `scripts/` (absent from CI's clone: `git add` them or list them in `.gitignore`) and warns on uncommitted tracked changes |
| macOS shared runner | your machine | timing-sensitive tests can fail on CI only |

`scripts/ci-hook-parity.test.ts` fails when `ci.yml` runs a `pnpm` command that the hook neither runs nor lists, with a reason, in its `EXCEPTIONS`.

CI runs on `pull_request` and on pushes to `main`: a branch push with an open PR runs once. A branch pushed without a PR does not run CI; the hook has already run the same checks.

`git push --no-verify` is the only bypass. The hook path is shared by all worktrees through the common `.git/config`; each worktree needs one `pnpm install` (or `pnpm prepare`) to generate its untracked `.husky/_`.

### Autonomous Claude Code sessions (local opt-in only)

The repo ships no `.claude/settings.json` and no auto-approve hook: a clone of this public repo must not grant any agent a permission bypass by default. If you want an autonomous session in your own checkout, add your own `.claude/settings.local.json` (already gitignored) with a `permissions.defaultMode` and any `PreToolUse`/`PermissionRequest` hook you're comfortable with — it stays local to your machine and is never committed.

OpenFleet-launched `claude` sessions ignore a project's `.claude/settings.json` (and `settings.local.json`) entirely (AUD-28), so the file above has no effect on them; a per-project reconcile/import of those settings is planned (AUD-29).

Live smoke checklist (needs a real `claude` subscription, not run in CI): `docs/phase1-smoke.md`.
