# OpenFleet

Open-source desktop workspace for fleets of AI coding agents: sessions in git worktrees, manager agents with a pulse, mission notes, tables, triggers and human governance.

Status: phase 1 (foundation). See `docs/` for the phase smoke checklist; design lives in the author's superpowers folder for now.

## Dev

Requires Node >=26 — `nvm use` in this repo picks up Homebrew's Node via `.nvmrc` (`system`); on a shell where nvm's `default` alias points elsewhere, prefix commands with `PATH="/opt/homebrew/bin:$PATH"` instead of changing the global alias.

    pnpm install
    pnpm test
    pnpm typecheck
    pnpm --filter @openfleet/desktop test
    pnpm e2e              # headless Playwright, fake harness, no Claude cost
    pnpm dev:core          # daemon on 127.0.0.1:7331
    pnpm dev               # daemon + Tauri window

### Pre-push hook

`pnpm install` installs a husky `pre-push` hook (`scripts/pre-push.sh`) that runs what CI runs: `pnpm typecheck`, `pnpm test`, `pnpm --filter @openfleet/desktop test`, stopping at the first failure. It puts `/opt/homebrew/bin` first in `PATH` when present and refuses a Node older than 26.

`pnpm e2e` is opt-in (needs ports 1420 and 7332 free): `OPENFLEET_PREPUSH_E2E=1 git push`.

`git push --no-verify` is the only bypass. The hook path is shared by all worktrees through the common `.git/config`; each worktree needs one `pnpm install` (or `pnpm prepare`) to generate its untracked `.husky/_`.

Live smoke checklist (needs a real `claude` subscription, not run in CI): `docs/phase1-smoke.md`.
