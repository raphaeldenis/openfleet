# OpenFleet

Open-source desktop workspace for fleets of AI coding agents: sessions in git worktrees, manager agents with a pulse, mission notes, tables, triggers and human governance.

Status: phase 1 (foundation). See `docs/` once it exists; design lives in the author's superpowers folder for now.

## Dev

Requires Node >=26 — `nvm use` in this repo picks up Homebrew's Node via `.nvmrc` (`system`); on a shell where nvm's `default` alias points elsewhere, prefix commands with `PATH="/opt/homebrew/bin:$PATH"` instead of changing the global alias.

    pnpm install
    pnpm test
    pnpm dev:core        # daemon on 127.0.0.1:7331
