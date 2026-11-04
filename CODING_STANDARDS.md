# Coding standards

What the code of this repository does today, plus the rules already decided for it. Every rule names a file of the repository as its example, by path relative to the root. Nothing here invents a rule: a statement that neither the code nor a document establishes is marked `UNVERIFIED`. This page does not replace [docs/house-rules.md](docs/house-rules.md), [CONTRIBUTING.md](CONTRIBUTING.md), [GLOSSARY.md](GLOSSARY.md) or the pages under [docs/](docs/): where it says less, those pages decide; where it would say otherwise, that is a conflict to report, not a change of rule.

Who reads it: a reviewer checking a change against the repository's conventions (the Standards axis of a code review), and anyone writing a test or a fix test-first.

Contents: [1. Observed conventions](#1-observed-conventions), [2. Deep modules, seams and adapters](#2-deep-modules-seams-and-adapters), [3. Tests](#3-tests), [4. Known deviations](#4-known-deviations), [5. What we do not do](#5-what-we-do-not-do).

## 1. Observed conventions

### 1.1 Languages and stack

| Part | Language and runtime | Where | Source |
| --- | --- | --- | --- |
| Daemon `@openfleet/core` | TypeScript, ESM, Node 26 or newer, `node:sqlite`, `node-pty`, `ws`, `@modelcontextprotocol/sdk`, zod 4 | `packages/core/src` | `packages/core/package.json`, root `package.json` (`engines.node >=26`) |
| Wire contract `@openfleet/shared` | TypeScript, isomorphic, zod as its only dependency | `packages/shared/src` | `packages/shared/package.json`, `.dependency-cruiser.cjs` rule `shared-imports-only-zod` |
| Desktop `@openfleet/desktop` | Angular 22, standalone components, signals, inline templates, SCSS, xterm | `apps/desktop/src/app` | `apps/desktop/package.json`, `apps/desktop/angular.json` |
| Native shell | Rust 2021, minimum 1.88.0, Tauri 2, Clippy pinned at 1.99.0 | `apps/desktop/src-tauri` | `apps/desktop/src-tauri/Cargo.toml`, `scripts/pre-push.sh` (`CLIPPY_RUST_VERSION`) |
| Scripts | TypeScript run by `tsx`, `.mjs` for release tooling, POSIX `sh` for hooks and shims | `scripts/` | `scripts/tsconfig.json`, `scripts/release/set-version.mjs`, `scripts/pre-push.sh` |
| Tests | Vitest 4 everywhere; `@testing-library/angular` and jsdom for the desktop; Playwright for the e2e; `cargo test` and `syn` for the Rust crate | see [3. Tests](#3-tests) | `vitest.config.ts`, `apps/desktop/playwright.config.ts`, `apps/desktop/src-tauri/Cargo.toml` (`dev-dependencies`) |

Package manager: pnpm, workspace of `packages/*` and `apps/*` (`pnpm-workspace.yaml`). Node version: `.nvmrc` reads `system`; the hook and CI require 26 (`docs/house-rules.md`, "Hooks and CI").

TypeScript is strict with `noUncheckedIndexedAccess` for every package (`tsconfig.base.json`); the desktop adds `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `noImplicitReturns`, `noFallthroughCasesInSwitch` and strict Angular templates (`apps/desktop/tsconfig.json`).

### 1.2 Repository layout

The map and the roles are in [README.md](README.md#layout) and [docs/architecture.md](docs/architecture.md). What matters for a change:

- **Feature folders, not layers.** The daemon is organised by subject under `packages/core/src`: `sessions/`, `managers/`, `notes/`, `stores/`, `policy/`, `governance/`, `escalation/`, `triggers/`, `playbooks/`, `secrets/`, `usage/`, `db/`, `harness/`, `mcp/`, `api/`. A feature folder holds its service, its repository, its typed errors and its tests side by side (`packages/core/src/notes/`: `noteService.ts`, `noteRepository.ts`, `noteSections.ts`, `noteService.test.ts`).
- **`api/` is the top of the daemon**, wired only by the composition root `packages/core/src/daemon.ts` and `packages/core/src/main.ts` (`.dependency-cruiser.cjs` rule `only-the-daemon-wires-the-api`). Services never import `api/`.
- **The desktop app** has four kinds of folder under `apps/desktop/src/app`: `design/` (leaf building blocks), `core/` (app-wide services and pure helpers), one folder per screen area (`inbox/`, `managers/`, `notes/`, `onboarding/`, `projects/`, `sessions/`, `settings/`, `tables/`, `working-state/`, and also `audit/`, `toolkit/`, `usage/`), and `shell/` which composes them through lazy routes (`apps/desktop/src/app/app.routes.ts`). The import rules between them are in `.dependency-cruiser.cjs` and the table of `apps/desktop/README.md`, "Architecture".
- **Test helpers live in named places**: `*.testkit.ts` next to the code, `__testing__/`, `__fixtures__/`, `apps/desktop/src/testing/`, `apps/desktop/src/app/testing/`, `apps/desktop/e2e/support/`. Production code never imports them (rule `production-code-never-imports-test-helpers`; `packages/core/src/productionSources.test.ts`).
- **Migrations** are `packages/core/src/db/migrations/NNN_<subject>.sql` with, since 041, a matching `packages/core/src/db/migrations-down/NNN_<subject>.down.sql`. The checklist is `packages/core/src/db/README.md`.
- **Docs** are one page per contract or feature under `docs/`, decisions under `docs/adr/NNNN-<slug>.md` with a `status` and `date` frontmatter (`docs/adr/0003-merge-policy-human-by-default.md`). `docs/errors.md` is generated by `pnpm docs:errors` and never edited by hand.

### 1.3 Naming

- **Files.** Daemon, shared and scripts: `camelCase.ts`, one subject per file, the suffix says the role: `noteService.ts`, `noteRepository.ts`, `escalationRoutes.ts`, `tableTools.ts`, `governanceErrors.ts`, `gitPort.ts`, `policy/ports.ts`, `fakeHarness.ts`, `fakeGh.testkit.ts`. Desktop: `kebab-case` with the Angular suffix: `state-chip.component.ts`, `fleet-api.service.ts`, `reply-draft.store.ts`, `handoff-preview.adapter.ts`, `handoff-preview.api.ts`, `command-policy.state.ts`. Rust: `snake_case.rs`. A migration is `NNN_snake_case.sql`.
- **Tests** sit next to the code they exercise: `<subject>.test.ts` in the daemon, shared and scripts; `<subject>.spec.ts` in the desktop; `<journey>.spec.ts` under `apps/desktop/e2e`. A second file on the same subject names its angle: `sessionService.launchFailure.test.ts`, `notes-view.live-refresh.spec.ts`. The suffix families (`.qe`, `.hostile`, `.daemon`, `.contract`, `.golden`, `.live`, `.probe`, `.review`) are in [3.3](#33-conventions-of-the-test-code).
- **Classes** are `PascalCase` with their role as suffix: `SessionService`, `NoteRepository`, `ClaudeCliHarness`, `FakeHarness`, `EventBus`, `StaleRevisionError`. Interfaces carry no `I` prefix: `Harness`, `GitPort`, `SecretStore`, `DocsFolderFs`.
- **Constants** are `UPPER_SNAKE_CASE` and carry their unit: `INTEGRATION_TIMEOUT_MILLISECONDS` (`packages/core/vitest.config.ts`), `REQUEST_TIMEOUT_MS` (`apps/desktop/src/app/core/fleet-api.service.ts`), `MAX_BODY_BYTES` (`packages/core/src/notes/noteService.ts`). Closed lists are `as const` arrays with a zod enum and an inferred type next to them: `NOTE_FOLDERS`, `NoteFolderSchema`, `NoteFolder` (`packages/shared/src/notes.ts`); `ERROR_KINDS`, `ErrorKind` (`packages/shared/src/errors.ts`).
- **Booleans** read as a question: `isPass` (`packages/shared/src/gateStep.ts`), `isStaleRevision` (`packages/core/src/api/answerError.ts`), `hasInvisibleCharacters` (`packages/core/src/harness/fakeHarness.ts`), `wasConversationNotFound` (`packages/core/src/harness/harness.ts`).
- **Explaining variables.** A condition or a transformation gets a business name before it is used: `const isStaleRevision = envelope.error === 'stale_revision' && …` (`packages/core/src/api/answerError.ts`), `const abortsOnCallerOrTimeout = …` (`apps/desktop/src/app/core/fleet-api.service.ts`), `let invokes_macro = …` (`apps/desktop/src-tauri/src/event_log/arch_test.rs`). Early returns replace nesting (`evaluateGateStep` in `packages/shared/src/gateStep.ts`).
- **Named options, not positional flags.** Functions take an object with named fields: `withGitTimeBudget(git, { budgetMs, nowMs })` (`packages/core/src/git/timeBudgetedGitPort.ts`), `runDepcruise({ cwd, extraArgs })` (`scripts/arch.test.ts`), `new NoteService({ repo, db, expandMentions, clock, newId })` (`packages/core/src/notes/noteService.ts`).
- **Wire identifiers** are `snake_case`: error codes (`stale_revision`, `packages/shared/src/errors.ts`), MCP tool names (`get_data_store`, `packages/core/src/mcp/toolCatalog.ts`), hook event payload fields, SQL columns.
- **Angular selectors** are prefixed `of-` (`of-state-chip`, `of-app-shell`, `of-inbox`); the only exception is the root `app-root` (`apps/desktop/src/app/app-root.ts`). Elements the tests target carry a `data-testid` (`state-chip`, `inbox-gate-card`).
- **Comments say why, in the present tense**, and the name does the what: `// A ZodError is matched by name, not by class: one thrown by a second copy of zod is a different class.` (`packages/core/src/errors/describeError.ts`). A deliberate shortcut is marked `// ponytail:` with its reason and the condition that would lift it (`packages/core/src/mcp/mcpServer.ts`, `packages/core/src/db/backup.ts`, `apps/desktop/src/app/notes/markdown-blocks.ts`). JSDoc on an interface states the contract a caller must know, including error modes (`packages/core/src/secrets/secretStore.ts`, `packages/core/src/notes/docsFolderFs.ts`).
- **Language.** Identifiers, comments, commit subjects, docs and PR titles are in English; PR bodies are in French (`CONTRIBUTING.md`, "Pull requests"; `.github/pull_request_template.md`).

### 1.4 Imports

- ESM everywhere (`"type": "module"`). In the daemon, shared and scripts, a relative import names the `.js` extension because the module resolution is `NodeNext` (`packages/core/src/notes/noteService.ts`: `from '../db/transaction.js'`). The desktop uses `module: preserve` and writes no extension (`apps/desktop/src/app/sessions/handoff/handoff-preview.adapter.ts`).
- Node built-ins carry the `node:` prefix (`import { randomUUID } from 'node:crypto'`, `packages/core/src/ids.ts`).
- Type-only imports use `import type` or inline `type` (`import { ERROR_CODES, type ErrorCode } from '@openfleet/shared'`, `packages/core/src/errors/describeError.ts`).
- A package is consumed through its entry point, `@openfleet/shared`, never through its `src/` files (rule `packages-are-imported-through-their-entry-point`). `packages/shared/src/index.ts` re-exports every module of the package.
- zod is imported as a namespace, `import * as z from 'zod'`, in every production file of `packages/shared` (`packages/shared/src/notes.ts`); `packages/shared/src/zodImportStyle.test.ts` fails on any other form. The reason is the desktop bundle budget (README, "Build budget").
- The daemon and the desktop never import each other (rules `core-never-imports-desktop`, `desktop-never-imports-core`); the harness adapter is reached only through `packages/core/src/harness/harness.ts` (rule `only-the-harness-folder-touches-the-claude-cli`).
- Import order, observed and not enforced: Node built-ins, then third-party and `@openfleet/shared`, then relative paths (`packages/core/src/errors/describeError.ts`, `packages/core/src/mcp/mcp.test.ts`).

### 1.5 Error handling

The model is one registry, one envelope, typed errors at the source and one translation point per surface.

- **Registry.** Every wire code lives once in `ERROR_CODES` with its kind; the kind fixes the HTTP status and the default retry rule (`packages/shared/src/errors.ts`). A new code is added there first; `docs/errors.md` is regenerated with `pnpm docs:errors` and `scripts/errors/errorReference.test.ts` fails while it is stale.
- **One envelope** for REST, MCP and WebSocket: `{ error, kind, retry, message, hint?, detail?, id? }` (`docs/errors.md`, "The envelope"). Callers key on `error`, never on `message`.
- **Typed errors at the source.** A feature throws its own `Error` subclasses with the facts a caller needs as `readonly` fields: `StaleRevisionError(currentRev, conflictingSections)`, `NoteTooLargeError(byteLength)` (`packages/core/src/notes/noteService.ts`); `LawRevisionConflictError(currentRev)` (`packages/core/src/governance/governanceErrors.ts`). A refusal the code can name directly throws `OpenFleetError(code, message, { hint })` (`packages/core/src/secrets/secretStore.ts`).
- **One translation point per surface.** `describeError` turns whatever was thrown into an envelope through an ordered list of rules (`packages/core/src/errors/describeError.ts`); `answerError` is the one place a REST error is written (`packages/core/src/api/answerError.ts`); `fail` and `refuse` render the MCP grammar `error <code>: <message> (retry: …[, ref <id>])` (`packages/core/src/mcp/toolResults.ts`); the desktop maps every code to a sentence in `COPY_BY_CODE`, typed `Record<ErrorCode, CodeCopy>` so that a new code fails `pnpm typecheck` until it has copy (`apps/desktop/src/app/core/error-copy.ts`).
- **Internal errors forward nothing.** An `internal` envelope carries a generic sentence and an 8-hex `id`; the log line carries the words (`describedOpenFleetError`, `UNEXPECTED_ENTRY` in `packages/core/src/errors/describeError.ts`; `shortId` in `packages/core/src/ids.ts`). Messages that would carry a path are fixed strings (`REOPEN_ENTRY_BY_CODE`).
- **Outcomes as discriminated unions** where a result is not an exception: `NoteUpdateResult` (`packages/core/src/notes/noteRepository.ts`), `GateStepVerdict` (`packages/shared/src/gateStep.ts`), `TodosLoad` (`apps/desktop/src/app/shell/todos/session-todos-source.ts`).
- **Gates fail closed.** A check that cannot tell "passed" from "never ran" fails: `evaluateGateStep` passes only on found, exit 0, non-blank, parsable output (`docs/gate-steps.md`). The git guardrail hook fails closed when it cannot parse (`docs/git-guardrails.md`, `.claude/hooks/block-dangerous-git.sh`).
- **Secrets stay out of errors and logs.** `packages/core/src/redact.ts` holds the masking rules shared by `describeError` and the logger (`packages/core/src/logger.ts`); `packages/core/src/noLiteralTokenShape.test.ts` refuses a literal credential shape in any core or shared test; the Rust crate bans the output macros and raw file creation (`apps/desktop/src-tauri/clippy.toml`, `apps/desktop/src-tauri/src/event_log/arch_test.rs`).
- **Logging** goes through `log(level, message, fields)` of `packages/core/src/logger.ts`; every static message is listed in `apps/desktop/src-tauri/daemon_messages.txt` and `packages/core/src/logCatalogue.test.ts` fails on a missing or stale entry. No `console.log` exists in production sources of the daemon, the shared package or the desktop app (checked with a grep on 2026-11-04).

### 1.6 Lint, format and type checks

There is no ESLint, Biome or other linter configuration in the repository. What stands in for one:

| Check | What it enforces | Where |
| --- | --- | --- |
| `tsc --noEmit` on every package, the desktop app and specs, and `scripts/` | strict TypeScript (see 1.1) | `pnpm typecheck`, root `package.json` |
| dependency-cruiser | the layering rules listed in README, "Architecture checks"; cycles; unresolvable imports; entry-point imports | `pnpm arch`, `.dependency-cruiser.cjs`, `scripts/arch.test.ts` |
| Source-scan tests (tests that read source files) | zod import style; no test runner in production code; no literal token shape in tests; every daemon log literal catalogued; no hard-coded e2e ports; focus-ring widths in the desktop; release `.gitignore` contents; hook and CI parity | `packages/shared/src/zodImportStyle.test.ts`, `packages/core/src/productionSources.test.ts`, `packages/core/src/noLiteralTokenShape.test.ts`, `packages/core/src/logCatalogue.test.ts`, `scripts/e2e/noHardcodedPorts.test.ts`, `scripts/focus-ring-source-scan.test.ts`, `scripts/release/gitignore.test.ts`, `scripts/ci-hook-parity.test.ts` |
| Contract pins | the MCP tool schemas against `contract.pinned.json` and `CONTRACT_VERSION`; the wire codes; the error envelope shape; the migration files and their checksums | `packages/core/src/mcp/contractGuard.test.ts`, `packages/core/src/errors/wireCodes.contract.test.ts`, `packages/core/src/api/errorEnvelope.contract.test.ts`, `packages/core/src/db/migrate.freshdb.test.ts`, `packages/core/src/db/migrate.pinnedChecksums.test.ts` |
| Rust | `cargo test --lib` on 1.88.0; Clippy 1.99.0 with `-D warnings`; banned macros and methods; a `syn`-based source policy on the event log | `.github/workflows/ci.yml`, `scripts/cargo-clippy.sh`, `apps/desktop/src-tauri/clippy.toml`, `apps/desktop/src-tauri/src/event_log/arch_test.rs` |
| Angular production build | bundle budgets (470 kB warning, 600 kB error), strict AOT templates | `apps/desktop/angular.json`, CI job `test` |

Formatting: `apps/desktop/.prettierrc` (print width 100, single quotes, Angular parser for HTML) and `apps/desktop/.editorconfig` (2 spaces, single quotes, final newline) exist for the desktop app only. No format script or hook runs Prettier; the observed style across the repository is 2-space indentation, single quotes, trailing commas in multi-line literals, and inline Angular templates and styles (no `templateUrl` or `styleUrls` anywhere under `apps/desktop/src/app`). See [4. Known deviations](#4-known-deviations) for what this leaves unenforced.

### 1.7 Verification commands

| Command | What it runs | Who runs it |
| --- | --- | --- |
| `pnpm arch` | dependency-cruiser over the three `src` roots | hook, CI, `scripts/verify.sh` |
| `pnpm typecheck` | `tsc --noEmit` everywhere | hook, CI, `scripts/verify.sh` |
| `pnpm test` | root Vitest: `packages/*` and `scripts/` projects (`vitest.config.ts`) | hook, CI |
| `pnpm --filter @openfleet/core test` | the daemon suites only | `scripts/verify.sh` |
| `pnpm --filter @openfleet/desktop test` | `ng test` (Vitest, jsdom, `apps/desktop/src/test-setup.ts`) | hook, CI |
| `pnpm --filter @openfleet/desktop build` | the production build with its budgets | CI; hook when the push touches the desktop or `packages/shared` |
| `pnpm e2e` | Playwright on a throwaway daemon with the fake harness, free ports | CI; hook when the push touches `apps/desktop/src`, `packages/core/src/api` or `packages/shared/src` |
| `pnpm docs:errors` | regenerates `docs/errors.md` | the author of a new error code |
| `pnpm --filter @openfleet/core test:live` | the suites that need a logged-in `claude` (`OPENFLEET_LIVE=1`) | by hand, never in CI (`docs/phase1-smoke.md`) |
| `sh scripts/pre-push.sh` | the whole hook by hand; `OPENFLEET_PREPUSH_DRYRUN=1` lists the steps | anyone before a push |
| `bash scripts/verify.sh <worktree>` | `arch`, `typecheck`, core tests: a subset of CI (`docs/ci.md`, "scripts/verify.sh") | manager-driven sessions |

"Passing" is claimed only with a command output: the PR body separates `Vérification` from `Non vérifié` (`.github/pull_request_template.md`, `CONTRIBUTING.md`).

## 2. Deep modules, seams and adapters

Vocabulary used in this section: a **module** is anything with an interface and an implementation, whatever its size; its **interface** is everything a caller must know (types, invariants, error modes, configuration, timing); a **seam** is the place where behaviour can be swapped without editing the caller; an **adapter** is a concrete thing that satisfies the interface at a seam; a module is **deep** when much behaviour sits behind a small interface and **shallow** when the interface is about as complex as what it hides; **leverage** is what callers get from depth, **locality** what maintainers get.

How the repository's own words map onto this vocabulary: the code and `.dependency-cruiser.cjs` say **port** for the interface at a seam (`harness/harness.ts is the port and harness/claudeCli/ its adapter`; `packages/core/src/notes/gitPort.ts`; `packages/core/src/policy/ports.ts`; `apps/desktop/src/app/shell/todos/session-todos-source.ts`, "Port: what the Todos tab reads") and **adapter** for what fills it. `*Service` and `*Repository` are class-naming suffixes of the daemon and `.component` an Angular suffix; neither names a design unit here. `GLOSSARY.md` defines **Harness** as "the adapter that launches and drives an agent CLI for a session", which is the same use of the word.

### 2.1 The external seams of the repository

| Seam | Interface (the port) | Adapters | Enforced by |
| --- | --- | --- | --- |
| Agent CLI | `Harness`, `HarnessHandle`, `HarnessLaunch` in `packages/core/src/harness/harness.ts` | `ClaudeCliHarness` (`packages/core/src/harness/claudeCli/claudeCliHarness.ts`), `FakeHarness` (`packages/core/src/harness/fakeHarness.ts`, registered only with `OPENFLEET_E2E=1`) | `.dependency-cruiser.cjs` rule `only-the-harness-folder-touches-the-claude-cli` |
| Daemon to desktop (two processes) | the zod schemas and types of `@openfleet/shared` (`packages/shared/src/session.ts`, `events.ts`, `errors.ts`, `notes.ts`, …) | daemon side: `packages/core/src/api/restHandlers.ts`, `wsHandler.ts`, `packages/core/src/mcp/mcpServer.ts`; desktop side: `apps/desktop/src/app/core/fleet-api.service.ts`, `fleet-events.service.ts` | rules `core-never-imports-desktop`, `desktop-never-imports-core`, `shared-imports-only-zod` |
| Agent to daemon | the MCP tool contract (`CONTRACT_VERSION`, `packages/shared/src/mcpContract.ts`) and the hook events (`packages/shared/src/hooks.ts`) | `packages/core/src/mcp/tools.ts` and the `*Tools.ts` files; `packages/core/src/api/hooksHandler.ts` | `packages/core/src/mcp/contractGuard.test.ts`, `docs/mcp-contract.md` |
| Errors | `ERROR_CODES` and `ErrorEnvelope` (`packages/shared/src/errors.ts`) | `describeError` (`packages/core/src/errors/describeError.ts`), `answerError` (REST), `toolResults.fail` (MCP), `error-copy.ts` (desktop) | `wireCodes.contract.test.ts`, `errorEnvelope.contract.test.ts`, the `Record<ErrorCode, …>` type in `error-copy.ts` |
| git | `GitPort` (`packages/core/src/notes/gitPort.ts`) | `packages/core/src/git/nodeGitPort.ts`; `withGitTimeBudget` wraps a port in a time budget (`packages/core/src/git/timeBudgetedGitPort.ts`) | tests of each adapter |
| Docs folder on disk | `DocsFolderFs` (`packages/core/src/notes/docsFolderFs.ts`) | `nodeDocsFolderFs` (`packages/core/src/notes/nodeDocsFolderFs.ts`) and a test double | `DocsFolderService` takes the port in its deps |
| Command policy | `CommandPolicyHooks`, `DenialJournal`, `DenialReader` (`packages/core/src/policy/ports.ts`) | `packages/core/src/harness/claudeCli/claudePolicyHooks.ts`, `packages/core/src/policy/sqliteDenialJournal.ts` | `daemon.ts` wiring |
| Power | `PowerApi`, `PowerAssertion` (`packages/core/src/power/powerApi.ts`) | `caffeinatePowerApi.ts`; `fakeClock.testkit.ts` for the clock | `DaemonOptions.power` |
| Secrets | `SecretStore` (`packages/core/src/secrets/secretStore.ts`) | `parentBridgeSecretStore.ts` (the desktop keychain), `inMemorySecretStore.ts`, `createUnavailableSecretStore` | `DaemonOptions.secrets` |
| GitHub | `GhPullRequestPort` (`packages/core/src/github/ghPullRequestPort.ts`) | the `gh` CLI; `fakeGh.testkit.ts` | `DaemonOptions.gh` |
| Knowledge search | `KnowledgeSearchPort`, `KnowledgeRepositoryLookupPort`, `RepositoryScopePort` (`packages/core/src/knowledge/knowledgeSearchPort.ts`) | `knowledgeSearchService.ts`; `knowledgeTools.testkit.ts` | `createMcpHandler` deps |
| Desktop: Todos tab data | `SessionTodosSource` behind the injection token `SESSION_TODOS_SOURCE` (`apps/desktop/src/app/shell/todos/session-todos-source.ts`) | `live-session-todos-source.ts` (REST and WebSocket), `InMemorySessionTodosSource` | Angular DI |
| Desktop: handoff preview | `HandoffPreviewApi` (`apps/desktop/src/app/sessions/handoff/handoff-preview.api.ts`) | `createHandoffPreviewApi(fleetApi)` (`handoff-preview.adapter.ts`) | the store takes the api as input |

The composition root is `startDaemon` in `packages/core/src/daemon.ts`: it builds every service by hand and passes its dependencies in. `DaemonOptions` is the list of what a test may replace (clock, scheduler, harness binary check, policy evaluator, secret store, power api). This is the rule "accept dependencies, don't create them" applied at the top; inside, a service declares a `Deps` interface with the clock and id generator as functions (`NoteServiceDeps` in `packages/core/src/notes/noteService.ts`), so a test fixes time and ids without a mock (`packages/core/src/notes/noteService.test.ts`).

### 2.2 Deep and shallow, as observed

Deep (a small interface, much behaviour behind it):

- `SessionService` (`packages/core/src/sessions/sessionService.ts`): `create`, `createInWorktree`, `sendMessage`, `reopen`, `close`, `resumeAll` hide the PTY delivery state machine (`DeliveryPhase`), the launch watchdog, the bracketed-paste review and the relaunch rules. Callers and tests cross the same interface (`packages/core/src/mcp/mcp.test.ts`, `packages/core/src/api/*.test.ts`).
- `describeError(error, scope)` (`packages/core/src/errors/describeError.ts`): one function, every error of the daemon goes through it; a new rule is one line in `RULES`.
- `openDatabase(path)` (`packages/core/src/db/database.ts`): opens, backs up, migrates, verifies checksums and prunes backups behind one call (`packages/core/src/db/README.md`).
- `evaluateGateStep(outcome)` (`packages/shared/src/gateStep.ts`) and `isBlankText` (`packages/shared/src/isBlankText.ts`): pure, one input, one verdict, reused by the findings gate, the ship verdict and the gate runner.
- `maskedSecrets` and its rules (`packages/core/src/redact.ts`): one place, two consumers (envelope and logger).
- `StateChipComponent` (`apps/desktop/src/app/design/state-chip.component.ts`): five inputs, and the whole look table, the elapsed timer and the unknown-state fallback stay inside.

Shallow or pass-through, by the deletion test (delete it and nothing reappears elsewhere, or it reappears in exactly one caller):

- `apps/desktop/src/app/shell/todos/todos.adapter.ts`: two re-export lines of `@openfleet/shared`.
- `packages/core/src/api/*Routes.ts` and `restHandlers.ts`: thin HTTP translation per route by design; the behaviour is in the services. Their tests go through HTTP, which is the right surface for them.
- `FleetApiService` (`apps/desktop/src/app/core/fleet-api.service.ts`): one method per daemon route over one `call` helper. Wide interface, thin methods: a facade, kept because every screen would otherwise build the same request.

Internal seams (private to a module, used by its own tests): the `schedule` and `clock` fields of `DaemonOptions.childRestart`, `childSilence`, `silentBlocks`, `arbiter`, `triggers` (`packages/core/src/daemon.ts`); `FakeHandle`'s `Test-only` flags (`packages/core/src/harness/fakeHarness.ts`); `sources` of `applyMigrations`, kept "only so tests can inject a broken migration" (`packages/core/src/db/migrate.ts`).

Two adapters make a real seam, one adapter a hypothetical one. Every port in the table above has at least a production adapter and a test double, except where the table says otherwise; a port with a single adapter is debt to name, not a pattern to copy.

### 2.3 Where a change goes

- A new behaviour of the daemon goes in its feature folder: the service method first, its typed error next to it, the `describeError` rule, the REST route or MCP tool last, each behind the existing seam.
- A new external dependency (a binary, a network, the keychain) gets a port file in the feature folder and its adapter beside it; `daemon.ts` wires the adapter and `DaemonOptions` exposes the replacement for tests.
- A new wire field goes in `packages/shared` first, so both processes read the same type; an MCP tool change follows `docs/mcp-contract.md` (version, pin, changelog in one pull request).
- A new screen area is a folder under `apps/desktop/src/app`, lazy-loaded from `app.routes.ts`, importing `core/` and `design/` only; a new building block goes in `design/` and imports nothing above it.

## 3. Tests

### 3.1 The pyramid (FIX177)

Rule decided for the repository, reproduced as written (its sentence "Garde mécanique à venir" is now enforced: since 2026-11-04 the Scape `verify` and `open-pr` playbooks apply the guard, see 4.6):

> Pyramide de tests. Unitaire = test en boîte noire d'une feature entière : entrée → sortie par l'interface publique, jamais les détails d'implémentation (un refacto sans changement de comportement ne casse aucun test) ; c'est le niveau le plus nombreux. Intégration = cas limites et détail (valeurs précises, métriques, erreurs de bord) contre les vraies dépendances (vrai serveur, vraie base). E2E = parcours critiques à gros grain seulement (navigation, présence des cartes, boutons) ; un cas couvert en intégration n'est jamais doublé en e2e. Tout correctif de bug livre le test rouge puis vert qui reproduit le cas limite, au niveau le plus bas qui le reproduit (unitaire, sinon intégration) ; une reproduction par commande ou rejeu sert au diagnostic et n'est jamais le livrable à sa place. QE : un correctif sans ce test est un blocker. Garde mécanique à venir : verify et open-pr refusent une branche fix/ dont le diff n'ajoute ni ne modifie aucun fichier de test ; un changement sans test possible part sur chore/ ou docs/.

### 3.2 How the pyramid maps onto the repository

| Level | What it is here | Runner and location | Model to follow |
| --- | --- | --- | --- |
| Unit (black box of a whole feature) | a service, a pure helper or a component exercised through its public interface with real in-process dependencies (`:memory:` SQLite, fakes at the seams), never a private function | Vitest, `*.test.ts` beside the code in `packages/*`; `*.spec.ts` in `apps/desktop/src` rendered with `@testing-library/angular` | `packages/core/src/notes/noteService.test.ts`, `packages/shared/src/isBlankText.test.ts`, `apps/desktop/src/app/design/state-chip.component.spec.ts` |
| Integration (edge cases against real dependencies) | a booted server or daemon answering over HTTP, WebSocket and MCP; SQLite on disk; real git repositories; spawned processes | Vitest, same `*.test.ts` files, often suffixed `.daemon`, `.qe`, `.hostile`, `.contract`; 20 s timeout (`packages/core/vitest.config.ts`, `docs/test-load-timeouts.md`) | `packages/core/src/mcp/mcp.test.ts` (the model named in `docs/house-rules.md`), `packages/core/src/managers/managerMode.daemon.test.ts`, `packages/core/src/api/routeErrors.qe.test.ts` |
| E2E (coarse critical journeys) | Playwright against the built app and a throwaway daemon with the fake harness: navigation, cards present, buttons, sizes | `apps/desktop/e2e/*.spec.ts`, helpers in `apps/desktop/e2e/support/daemon.ts`, `pnpm e2e` | `apps/desktop/e2e/inbox.spec.ts`, `apps/desktop/e2e/onboarding-journey.spec.ts` |
| Live (opt-in, not a merge check) | suites that need a real `claude` | `*.live.test.ts`, `OPENFLEET_LIVE=1`, `.github/workflows/live.yml` | `packages/core/src/harness/claudeCli/claudeCliHarness.live.test.ts`, `docs/phase1-smoke.md` |

Existing rules, referenced and not restated: tests are black box through a real interface (`docs/house-rules.md`, "Tests"); a time budget measures CPU time, never wall-clock, and a test that needs more than 20 s declares its own timeout (`docs/test-load-timeouts.md`, "Rule for new tests"); a new migration is covered by `migrate.freshdb.test.ts` and needs no test of its own (`packages/core/src/db/README.md`); an MCP tool change refreshes the pin and the changelog (`docs/mcp-contract.md`, "The guard test"); the e2e boots its own home and ports and never reuses a running server (`apps/desktop/README.md`, "End-to-end tests"); a PR names what was run and what was not (`CONTRIBUTING.md`, "Pull requests").

### 3.3 Conventions of the test code

- **Arrange, act, assert** separated by blank lines, one behaviour per `it`, the sentence of the `it` states the behaviour in the present tense: `it('creates a note at revision 1 with an id and timestamp from its dependencies', …)` (`packages/core/src/notes/noteService.test.ts`); `test('a permission gate in the Inbox offers its decision pair at the standard button size', …)` (`apps/desktop/e2e/inbox.spec.ts`).
- **Fakes at the seams, not mocks of own modules.** `FakeHarness`, `InMemorySessionTodosSource`, `fakeGh.testkit.ts`, `fakeClock.testkit.ts`, a `clock` and `newId` passed as functions. `vi.spyOn(console, …)` silences and inspects the log; `vi.useFakeTimers` drives time in component specs. `vi.mock` appears in a minority of suites, mostly to inject filesystem or process faults (`packages/core/src/db/backup.faults.test.ts`, `packages/core/src/harness/claudeCli/trustDirectory.faults.test.ts`).
- **Tables with `it.each`** for one behaviour over many inputs (`packages/shared/src/isBlankText.test.ts`, `apps/desktop/src/app/design/state-chip.component.spec.ts`).
- **Desktop specs** render with `render` from `@testing-library/angular/zoneless`, bind inputs with `inputBinding`, and query by `data-testid` or by role (`getByRole('button', { name: 'Approve' })`); `@testing-library/jest-dom` matchers are loaded by `apps/desktop/src/test-setup.ts`, which also clears timers a test leaks (`apps/desktop/src/testing/leaked-timers.ts`).
- **Suffixes name the angle of a file**, not its level in the pyramid: `.qe.test.ts` (black-box tests written by the QE role, edge cases), `.hostile.test.ts` (malformed, oversized or adversarial input), `.daemon.test.ts` (a whole daemon booted with `startDaemon`), `.contract.test.ts` and `.golden.test.ts` (a pinned shape or output), `.probe.test.ts` (a boot probe), `.review.test.ts` (cases from a review), `.live.test.ts` (real `claude`), `.recette` (acceptance). Shared helpers are `*.testkit.ts`, fixtures `__fixtures__/`, test-only sources `__testing__/`.
- **Temporary state** goes in `mkdtemp` directories removed after the test, through `createTempDirTracker` (`packages/core/src/tempDirTracker.ts`) or `makeRepo` (`packages/core/src/git/testRepo.ts`); a cleanup a child process may race retries (`docs/test-load-timeouts.md`).
- **No literal credential shape** in a test (`packages/core/src/noLiteralTokenShape.test.ts`); synthetic tokens come from `packages/core/src/syntheticTokens.ts`.
- **Self-policing tests** stand in for a linter (see 1.6): a new rule of the repository is written as a test that scans the sources, with a message that says how to fix it (`packages/core/src/logCatalogue.test.ts`, `packages/core/src/mcp/contractGuard.test.ts`, `HOW_TO_FIX`).
- **A bug fix ships its test**: the red-then-green test that reproduces the edge case, at the lowest level that reproduces it, in the same commit or pull request (FIX177 above; observed on `main` in commits such as `fix(desktop): give each panic_hook test its own scratch folder so parallel tests stop sharing one log` and the `*.review.test.ts` and `scenario84` files). A command or a replay is diagnosis, never the deliverable.

## 4. Known deviations

What the code does today against the rules above. Listed, not corrected, with no ticket attached.

1. The desktop feature folders import each other in cycles (`sessions`, `inbox`, `managers`); no rule covers it (README, "Architecture checks"; `.dependency-cruiser.cjs` header).
2. `DESKTOP_FEATURE_FOLDERS` in `.dependency-cruiser.cjs` lists nine folders; `apps/desktop/src/app/audit/`, `toolkit/` and `usage/` are not in it, so the rules `app-services-import-no-feature` and `features-never-import-the-shell` do not cover them.
3. Formatting is not enforced: no format script, no hook, Prettier and editorconfig files only under `apps/desktop`. Line lengths vary from 100 to several hundred characters (`packages/core/vitest.config.ts`, `packages/core/src/mcp/mcp.test.ts` `beforeEach`, `packages/core/src/daemon.ts`).
4. `angular.json` declares `"prefix": "app"` while every component uses the `of-` prefix; a component generated by the CLI would come out with the wrong prefix.
5. Unit and integration suites share one runner, one file pattern and one 20 s timeout: `pnpm test` runs pure helpers and booted daemons together, and nothing in the file name or the config says which level a test belongs to. The `.qe`, `.daemon` and `.hostile` suffixes name an angle, not a level (3.3). Whether any case covered in integration is also covered in e2e: `UNVERIFIED`.
6. The mechanical guard named by FIX177 is active since 2026-11-04 and lives in the Scape `verify` and `open-pr` playbooks, not in the repository: `scripts/verify.sh` and `scripts/open-pr.sh` do not check the branch prefix or the presence of a test file in the diff, and `CONTRIBUTING.md` records no enforced branch naming scheme.
7. `apps/desktop/e2e/support/daemon.ts`, `scripts/errors/renderErrorReference.ts`, `scripts/e2e/daemonIssuesReport.ts` and `scripts/pre-push.sh` reach `packages/shared/src/…` by relative path; dependency-cruiser runs on the three `src` roots only, so the entry-point rule does not see `apps/desktop/e2e` or `scripts/`.
8. `packages/core/src/sessions/sessionService.ts` is 2 571 lines and keeps module-level state (`activeHandleBySessionId`), justified by a `ponytail:` comment that names the multi-daemon case as the condition to revisit it.
9. `packages/core/src/errors/describeError.ts` imports error classes from about twenty feature modules: the typed errors live at their source (locality), the mapping is central (one more import per new error). `describeError.completeness.test.ts` guards the mapping.
10. The service graph is rebuilt by hand in the `beforeEach` of many API and MCP suites (`packages/core/src/mcp/mcp.test.ts`, `packages/core/src/api/routeErrors.qe.test.ts`, `packages/core/src/api/errorEnvelope.hostile.test.ts`) rather than through one shared testkit; the `.daemon.test.ts` suites use `startDaemon` instead.
11. `apps/desktop/src/app/shell/todos/todos.adapter.ts` is a pure re-export (a pass-through by the deletion test).
12. One `any` in a test helper (`packages/core/src/mcp/tableTools.testkit.ts`); none found in production sources on 2026-11-04.
13. Documentation that no longer matches the tree, reported here and left to the owners of those pages: `docs/house-rules.md` ("No secrets in the repo") and README ("Autonomous Claude Code sessions") say the repo ships no `.claude/settings.json`, while `.claude/settings.json` is tracked and installs the `PreToolUse` git guardrail hook (a deny hook, not an auto-approve one); `docs/ci.md` ("Known gaps") says no pull request template and no CONTRIBUTING file exist; `docs/architecture.md` counts migrations 001 to 062 while the tree holds 068; README reads Clippy as advisory in one paragraph and blocking in the next (already noted in `docs/ci.md`).

## 5. What we do not do

- No linter beyond `tsc`, dependency-cruiser, Clippy and the source-scan tests; no ESLint or Biome configuration (1.6).
- No ORM and no query builder: raw SQL through `node:sqlite`, numbered migrations, `STRICT` tables, text ids and ISO timestamps (`packages/core/src/db/README.md`).
- No HTTP framework: the daemon's own `Router` (`packages/core/src/api/router.ts`). No server-sent events (`docs/architecture.md`, "SSE").
- No Angular `HttpClient`, interceptors or state-management library: `fetch` with `AbortSignal`, signals and small stores (`apps/desktop/src/app/core/fleet-api.service.ts`, `ponytail:` comment).
- No business logic in the desktop app or the Tauri shell: both talk to the daemon (`apps/desktop/README.md`, "In brief").
- No import of another package's `src/`, no import of test code from production code, no import cycle (`.dependency-cruiser.cjs`).
- No regeneration of `.dependency-cruiser-known-violations.json` to admit a violation, no edit of a shipped migration, no version bump outside `scripts/release/set-version.mjs` (`docs/house-rules.md`).
- No `git push --no-verify` as a habit: it is the only bypass and it is named as one (`docs/house-rules.md`). No history rewrite, force-push or destructive git command from an agent session (`docs/git-guardrails.md`).
- No tokens, `.env` files or passwords in the repository, no secret in a log line or an error envelope, no literal credential shape in a test (1.5).
- No `console.log` in the daemon, no `println!` or `log::` macro in the Rust crate (`packages/core/src/logger.ts`, `apps/desktop/src-tauri/clippy.toml`).
- No gate that passes on a missing command, an empty output or a swallowed exit code; no `|| true` on a decisive step (`docs/gate-steps.md`).
- No wall-clock time budget in a test, no global timeout above 20 s, no test of a private function (`docs/test-load-timeouts.md`, `docs/house-rules.md`).
- No real `claude` in CI and no Claude cost in `pnpm e2e` (`docs/house-rules.md`, "Tests").
- No exact model id in a profile, only the rungs (`docs/adr/0002-model-aliases-only.md`). No person-specific content in the default team pack (`docs/adr/0006-no-personal-content-in-default-pack.md`). No merge by an agent by default (`docs/adr/0003-merge-policy-human-by-default.md`).
- No agent name and no trailer in a pull request title or body; no PR body in English (`.github/pull_request_template.md`, `CONTRIBUTING.md`).
- No absolute local path in a document of the repository.
