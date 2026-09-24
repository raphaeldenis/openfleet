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

Live smoke checklist (needs a real `claude` subscription, not run in CI): `docs/phase1-smoke.md`.
