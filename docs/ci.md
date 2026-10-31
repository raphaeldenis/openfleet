# CI

## En bref

Every pull request and every push to `main` runs three GitHub Actions jobs: `rust`, `test` and `e2e` (`.github/workflows/ci.yml:2-5,11,64,78`). They run in parallel. If one is red, the change is not safe to merge. The same checks run on your machine before each push through a git hook, so most failures show up before CI starts. Whether GitHub actually blocks a merge on red checks is a repository setting that this repo does not record: see [Branch protection](#branch-protection).

## What CI runs

Workflow `ci` (`.github/workflows/ci.yml`). It triggers on `push` to `main` and on every `pull_request` (`ci.yml:2-5`). Its token is read-only (`ci.yml:7-8`).

| Job | Runner | What it does | Source |
| --- | --- | --- | --- |
| `rust` | `macos-latest`, 30 min timeout | `cargo +1.88.0 test --locked --lib` on the Tauri crate, then Clippy 1.99.0 on all targets with `-D warnings` through `scripts/cargo-clippy.sh` | `ci.yml:11-13,39-42` |
| `test` | `macos-latest` | `pnpm install --frozen-lockfile`, `pnpm arch`, `pnpm typecheck`, desktop production build, `pnpm test`, desktop tests | `ci.yml:64-76` |
| `e2e` | `macos-latest` | `pnpm install --frozen-lockfile`, installs Chromium for Playwright, `pnpm e2e` | `ci.yml:78-87` |

Details:

- Node is 26 in `test` and `e2e` (`ci.yml:70,84`). `package.json` requires `>=26` (`package.json:7-9`).
- `pnpm arch` runs dependency-cruiser on `packages/core/src`, `packages/shared/src` and `apps/desktop/src` (`package.json:13`). A violation fails the job.
- `pnpm typecheck` runs `tsc --noEmit` on every package, on the desktop app and spec configs, and on `scripts/` (`package.json:12`).
- `pnpm test` is `vitest run` at the repo root (`package.json:11`).
- `pnpm e2e` runs the Playwright tests of `apps/desktop` (`package.json:20`).
- The `rust` job caches Cargo downloads and build outputs. Only a run on `main` saves a missing cache entry (`ci.yml:26-38,52-54`). It writes its extra macOS runner time to the job summary (`ci.yml:43-51`).
- Clippy fails the job on any warning (`-D warnings`, `ci.yml:42`). `scripts/cargo-clippy.sh` keeps Clippy's exit code (`cargo-clippy.sh:16`) and adds a diagnostic count to the job summary (`cargo-clippy.sh:11-15`).

A second workflow, `live` (`.github/workflows/live.yml`), never runs on push or pull request. It starts only by hand (`workflow_dispatch`, `live.yml:2,11-12`), uses the `live` environment (`live.yml:24`) and drives a real `claude` CLI. It is not a merge check.

## Required checks to merge

What the code defines: three jobs, `rust`, `test` and `e2e`, each report a status on the pull request.

What the code does not define: which of them GitHub treats as required. No file in the repo configures this (searched in `.github/`, `README.md`, `RELEASING.md`, `docs/`).

- Required check list on GitHub: **UNVERIFIED**. A human with repo access confirms it with `gh api repos/raphaeldenis/openfleet/branches/main/protection` (the `required_status_checks` field). The exact context names GitHub would list are not recorded either; `gh pr checks <number>` on any PR shows the names it reports.
- Which checks should be required: **à décider par Raphaël**.

## Branch protection

**UNVERIFIED.** Branch protection is a GitHub setting. The repo does not store it, and this guide was written without access to it. To read the real state, a human runs:

```
gh api repos/raphaeldenis/openfleet/branches/main/protection
```

A 404 answer ("Branch not protected") means no protection is configured. Rulesets are a separate API: `gh api repos/raphaeldenis/openfleet/rulesets`.

What the repo does say about merging: the default merge policy is human. An agent opens a draft PR, a person marks it ready and merges it, unless a project opts into merging on green checks (`docs/adr/0003-merge-policy-human-by-default.md:8`). That is a working agreement, not a GitHub rule. Whether GitHub enforces it: UNVERIFIED, same command.

The release flow tags and pushes only once its own checklist is green (`RELEASING.md:46`). It does not name a CI check.

## Replay CI on your machine

### The pre-push hook

`pnpm install` sets up a husky hook (`package.json:22`). `.husky/pre-push` runs `sh scripts/pre-push.sh "$@"`. The script says it "runs the checks CI runs" (`scripts/pre-push.sh:2`). Run it by hand from the repo root with `sh scripts/pre-push.sh`. With no input from git, it treats the current `HEAD` as the push (`pre-push.sh:95-97`).

Steps, in order, stopping at the first failure (`pre-push.sh:111-131`; `run_step` aborts at `pre-push.sh:26`):

1. `pnpm arch`
2. `pnpm typecheck`
3. `pnpm --filter @openfleet/desktop build`, only if the push touches `apps/desktop/src`, the files at the root of `apps/desktop`, or `packages/shared` (`pre-push-lib.sh:6`)
4. `pnpm test`
5. core tests with only `node` and `pnpm` on `PATH`, no `claude`, an empty `HOME` (`pre-push-lib.sh:84-105`); skipped when `claude` is not installed (`pre-push.sh:119-123`)
6. `pnpm --filter @openfleet/desktop test`
7. `cargo test --lib` (Rust 1.88.0 read from `Cargo.toml`) and Clippy 1.99.0 with `-D warnings`, only if the push touches `apps/desktop/src-tauri` (`pre-push-lib.sh:5`, `pre-push.sh:57-65,126-130`). The hook fails if Cargo or rustup is missing (`pre-push.sh:58-59`).
8. `pnpm e2e`, only if the push touches `apps/desktop/src`, `packages/core/src/api` or `packages/shared/src` (`pre-push-lib.sh:8`, `pre-push.sh:67-76`)

Switches and guards:

| What | Effect | Source |
| --- | --- | --- |
| `OPENFLEET_PREPUSH_DRYRUN=1` | prints the steps, runs nothing | `pre-push.sh:3,20-23` |
| `OPENFLEET_PREPUSH_E2E=1` / `=0` | forces / skips the e2e | `pre-push.sh:4`, `pre-push-lib.sh:107-114` |
| Node older than 26 | the hook refuses to run | `pre-push.sh:7,30-35` |
| Untracked, non-ignored files under `packages`, `apps`, `scripts` | the hook fails: CI's clean clone would not have them | `pre-push.sh:45-49`, `pre-push-lib.sh:7,59-62` |
| Uncommitted tracked changes in those folders | warning only | `pre-push.sh:51-55`, `pre-push-lib.sh:64-67` |
| `git push --no-verify` | skips the hook | `pre-push.sh:26` (message) |

A worktree can have no hook: `.husky/_` is generated and untracked, so a worktree without it pushes unchecked. Check with `test -f .husky/_/pre-push`; one `pnpm install` generates it (`README.md:158`).

What the hook does not replay: `pnpm install --frozen-lockfile`, the Playwright browser install, and the macOS CI runner (`README.md:150,152`).

`scripts/ci-hook-parity.test.ts` fails when `ci.yml` runs a `pnpm` command that the hook neither runs nor lists as an exception (`README.md:154`).

### scripts/verify.sh

`bash scripts/verify.sh <worktree>` runs three commands inside the given worktree, with `set -euo pipefail`, so the first failure stops it (`verify.sh:2,17-19`):

1. `pnpm arch`
2. `pnpm typecheck`
3. `pnpm --filter @openfleet/core test`

The worktree path is the one argument, or the `WORKTREE` variable. Without it the script prints its usage and exits 2 (`verify.sh:4-8`). It also exits 2 when the path is not a git worktree or has no `package.json` (`verify.sh:11-15`, `shim-guards.sh:3-11`).

`verify.sh` is a subset of CI: it does not run the desktop build, the desktop tests, the root `pnpm test`, Cargo, or the e2e. A green `verify.sh` does not mean a green CI. For the full replay, use `scripts/pre-push.sh`.

## Read a failure

1. Open the pull request, find the red check and click Details. The job log shows each step; the failing step is the first red one.
2. Match the step name to the table below and run the same command locally.

| Failing step in CI | Local command | What a failure means |
| --- | --- | --- |
| `pnpm arch` | `pnpm arch` | An import breaks a layering rule. The line reads `error <rule>: <importing file> → <imported file>`. Fix the import, not the rule (`README.md:126`). |
| `pnpm typecheck` | `pnpm typecheck` | A TypeScript error in a package, the desktop app, its specs or `scripts/`. |
| `pnpm --filter @openfleet/desktop build` | same | The production build fails (budgets, strict templates: `README.md:147`). |
| `pnpm test` | `pnpm test` | A root vitest test fails. |
| `pnpm --filter @openfleet/desktop test` | same | A desktop test fails. |
| Test Tauri library with the declared minimum Rust version | `cargo +1.88.0 test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` (with `TAURI_CONFIG` as in `ci.yml:15`) | A Rust test fails. |
| Lint all Tauri targets with pinned Clippy | `sh scripts/cargo-clippy.sh cargo +1.99.0 clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings` | Clippy reports a warning or error. The summary line at the end gives the count. |
| `pnpm e2e` | `pnpm e2e` | A Playwright test fails. |

Other facts that help:

- A CI-only failure with a local green: `README.md:152` notes that timing-sensitive tests can fail on the shared macOS runner only. The README gives no retry rule: UNVERIFIED whether to re-run; ask the PR owner.
- CI on a branch runs only when the branch has a PR or is `main`. A branch pushed without a PR does not run CI (`ci.yml:2-5`, `README.md:156`).
- The `live` workflow needs the secret `CLAUDE_CODE_OAUTH_TOKEN` in the `live` environment (`live.yml:8`). Its value is never in the repo and is not described here.

## Known gaps

- Required checks and branch protection: UNVERIFIED, see above.
- `README.md:132` says Clippy is advisory with `cargo +stable`; `README.md:140`, `ci.yml:41-42` and `pre-push.sh:62,64` show it blocking on 1.99.0. The code is the reference. The README line is stale.
- No pull request template and no CONTRIBUTING file exist in the repo (`.github/` holds only `workflows/`).
