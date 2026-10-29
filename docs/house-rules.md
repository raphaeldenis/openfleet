# House rules

Rules for anyone changing this repository. Each one restates what the repo already enforces or documents; the source is named so it can be checked.

## No secrets in the repo

- Tokens, passwords and `.env` files are never committed. The daemon's database files (`*.db`, `*.db-wal`, `*.db-shm`), `.mcp.json` and `.claude/settings.local.json` are gitignored (`.gitignore`) because they can hold tokens or local permissions.
- The repo ships no `.claude/settings.json` and no auto-approve hook: a clone must not grant an agent a permission bypass. An autonomous session is a local opt-in through your own `.claude/settings.local.json` (README, "Autonomous Claude Code sessions").
- The daemon logs carry no token and no hook URL (Fable audit of 2026-09-28, positive findings). A change that logs a request, a header or a command line keeps that property.

## Hooks and CI

- `pnpm install` installs the husky `pre-push` hook (`scripts/pre-push.sh`). It runs what CI runs: `pnpm arch`, `pnpm typecheck`, `pnpm test`, the desktop tests, and Cargo and e2e steps when the push touches the matching paths (README, "Pre-push hook").
- `git push --no-verify` is the only bypass. A worktree created outside OpenFleet needs one `pnpm install` (or `pnpm prepare`) to get the hook; check with `test -f .husky/_/pre-push`.
- The hook fails on untracked, non-ignored files under `packages/`, `apps/` and `scripts/`: `git add` them or list them in `.gitignore`.
- `scripts/ci-hook-parity.test.ts` fails when CI runs a `pnpm` command the hook does not run. Change both together, or list the exception with its reason.
- Node 26 or newer is required (`engines` in `package.json`, `.nvmrc`). The hook refuses an older Node.

## Architecture

- `pnpm arch` enforces the layering rules of `.dependency-cruiser.cjs` and runs in CI. Fix the import, not the rule.
- `.dependency-cruiser-known-violations.json` is empty and only shrinks. Never regenerate it to admit a new violation.
- `packages/shared` imports nothing but zod, because it ships to the browser. The daemon and the app never import each other; only `@openfleet/shared` is common.
- TypeScript is strict (`tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`). Schemas import zod as `import * as z from 'zod'` to keep the bundle small (README, "Build budget").

## Tests

- Tests are black box: they exercise behaviour through a real interface (HTTP and WebSocket against a booted daemon, the MCP surface, the rendered app, the Playwright e2e), not private functions. The Fable audit holds the HTTP/WS tests of `mcp.test.ts` up as the model to follow.
- `pnpm e2e` runs headless with a fake harness and costs no Claude usage. Tests that need a real `claude` subscription are opt-in (`OPENFLEET_LIVE=1`, `docs/phase1-smoke.md`) and do not run in CI.
- `pnpm e2e` starts its daemon on a fresh `OPENFLEET_HOME` and free ports, so it runs next to `pnpm dev`.

## Commits

- Commit subjects follow conventional commits: `type(scope): description`, with `!` after the type or scope for a breaking change. `scripts/release/release-lib.mjs` groups release notes by type (`feat`, `fix`, `perf`, `refactor`, `docs`; any other type lands under "Other changes") and skips `chore(release)` commits.

## Releasing

The version lives in `apps/desktop/src-tauri/tauri.conf.json` and is bumped only through `scripts/release/set-version.mjs`. The full local flow is in [RELEASING.md](../RELEASING.md).
