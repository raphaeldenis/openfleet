# Contract 15: what changes before the switch

`contract_version` 15 is not published: `git tag --list` prints nothing and there is no release. This page gathers, in one place, what a reader needs before moving a client or an installation from 14 to 15. It adds no behaviour and rewrites no history: the entries of `CHANGELOG.md` (the section "15" and the section "Unreleased") stay where they are and remain the record. Each row below names its source, either `path:line` in the code or the name of a CHANGELOG entry. A statement marked UNVERIFIED could not be found in the code.

## Summary

1. `CONTRACT_VERSION` is 15 (`packages/shared/src/mcpContract.ts:2`). Nothing in this page raises it.
2. Four tools are added: `submit_plan_questions`, `report_arbiter_opinion`, `approve_plan_criteria`, `get_manager_mission`. One tool changes its answer: `get_argus_status`.
3. BREAKING vs 14: `get_argus_status` no longer returns `manager.missionText`; read the mission with `get_manager_mission`.
4. BREAKING vs 14 (a call that succeeded now fails): `AskUserQuestion` is refused to every manager that a human did not create with `attended`; existing managers become supervised at migration 058.
5. `attended` cannot change after creation; any REST body that carries it gets 400 `invalid_body`.
6. The manager base is v7. A manager that has not read it is refused `create_session` with `base_not_read`.
7. Seven migrations, 056 to 062, each with a down script. Run order is the file order.
8. One new environment variable, `OPENFLEET_USAGE_INGESTION=1`, off by default. One new `config.json` key, `artifacts`.
9. New output: `session.failed`, `readinessDetail`, `no_start_signal`, two usage routes.
10. No release, no tag: switching means publishing 15 for the first time.

## A. BREAKING vs 14

| Change | What a client sees | Source |
| --- | --- | --- |
| `get_argus_status` drops the mission body | `manager.missionText` is gone; `manager.missionBytes` (UTF-8 bytes of the stored mission) and `manager.missionSha256` (hex) replace it. The REST `GET /api/managers/:id` view and the desktop still carry `missionText`. | `packages/core/src/mcp/toolViews.ts:83-89` (`missionDigestOf`, `managerView`); CHANGELOG entry STATUS-NO-MISSION-BODY01 in the section "15" |
| `get_manager_mission` reads the mission | Returns `missionText` (stored mission followed by the notes its `@note:` mentions point to, expanded as `get_note` does), `missionBytes`, `missionSha256`. Optional `manager_id` (only the caller's own), `offset`, `max_bytes`. Cap of 24 KiB per answer. A non-manager gets `not_a_manager`, another manager's id gets `outside_lineage`. | `packages/core/src/mcp/managerMissionTools.ts:24-32`; `packages/core/src/mcp/noteReadPaging.ts:2` (`NOTE_READ_SAFE_BYTES = 24 * 1024`); CHANGELOG entries `get_manager_mission` and MISSION-READ-PAGING01 |
| Paging of an oversized mission | When mission plus mentions exceed the cap, the stored mission comes back whole with `mentionsIndex` and `complete: false`; a stored mission that alone exceeds the cap is paged with `offset` (`nextOffset`, `nextAction`, `totalBytes`). | CHANGELOG entry MISSION-READ-PAGING01 (behaviour not re-read in code line by line: UNVERIFIED beyond the schema lines above) |
| `AskUserQuestion` refused to supervised managers | Refusal points to `submit_plan_questions`; decided by the daemon whatever the command policy mode; journaled once `denied`, rule `manager-ask-user-via-ladder`. An attended manager keeps it (journaled `observed`, rule `root-manager-ask-user`). | CHANGELOG entries ESCALATION-LADDER01 and ESCALATION-ATTENDED-FLAG01; `docs/escalation.md` (Limits) |
| Upgrade effect on existing managers | Every manager that exists before migration 058 has `attended = 0` and becomes supervised. A live manager that must keep `AskUserQuestion` is recreated with the box ticked. | `packages/core/src/db/migrations/058_session_attended.sql:1` (default 0, no backfill); CHANGELOG entry ESCALATION-ATTENDED-FLAG01 |
| `attended` is immutable | A request to `/api/sessions/:id…` or `/api/managers/:id…` whose body carries `attended` gets 400 `invalid_body`, "attended is immutable after creation", after authentication and before the handler (also for an unknown or closed session). A database trigger refuses the update too. Creation (`POST /api/sessions`, admin token, manager without parent) is unchanged. | `packages/core/src/api/refuseAttendedChange.ts:9`; `packages/core/src/db/migrations/058_session_attended.sql:3-6`; CHANGELOG entry ESCALATION-ATTENDED-REST400-01 |
| Escalation ladder | The daemon routes each question of `submit_plan_questions` to the manager, an arbiter or the human. The arbiter reports through `report_arbiter_opinion`; the manager asks for approval of the criteria with `approve_plan_criteria` (the daemon writes `criteria_status`). `contract` and `security` always stay on the human list. New error codes: `question_unclassified`, `escalation_open`, `criteria_stale`, `escalation_not_found`. Project setting `escalation` (`PATCH /api/projects/:id`, admin token). | CHANGELOG entry ESCALATION-LADDER01; `packages/shared/src/escalation.ts:103` (`maxArbiterRunsPerTicket`, default 3) |
| Reopen once, then `arbiter_dispute` | A question may carry `reopens: <question id>` with executed evidence in `resolution`. The first reopen goes to a new arbiter run (counted in `maxArbiterRunsPerTicket`). A second contest joins the single open escalation of the ticket with the reason `arbiter_dispute`. No third round. A refused reopen is `invalid_body` and stores nothing. | `packages/core/src/escalation/escalationService.ts:17` (`ARBITER_DISPUTE_REASON`); `docs/escalation.md` (Limits); CHANGELOG entry ESCALATION-REOPEN-F8A01 |
| Neutral arbiter working directory | The arbiter starts in an empty per-run directory `<OPENFLEET_HOME>/arbiter-workspaces/arbiter-<random>` (mode 0700) and reads the ticket worktree through `--add-dir=<real path>` (`read_directories`, migration 059). `POST /api/sessions` refuses a body with `readDirectories`. OpenFleet forces `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=0` for every launch that adds a read directory. Keep `OPENFLEET_HOME` outside any repository. | `packages/core/src/daemon.ts:109`; `packages/core/src/harness/claudeCli/claudeCliHarness.ts:106`; `packages/core/src/db/migrations/059_session_read_directories.sql:1`; CHANGELOG entries ESCALATION-ARBITER-NEUTRAL-CWD01, ESCALATION-CWD-FOLLOWUP01 |
| Manager base v7 | `packages/core/templates/manager/base.md` has `version: 7` (§4 step 2: "Read your mission with `get_manager_mission`"). v6 stays recorded as released. A manager that has not read the current base shows "Base v7, not read" and its `create_session` is refused `base_not_read` (enforcement `refuse` by default; `warn_only` downgrades it to a warning). | `packages/core/templates/manager/base.md:2`; `packages/core/src/managers/releasedBaseShas.ts:5-12` (keys 1 to 7); `packages/core/src/managers/baseReadGuard.ts:7,20`; `packages/core/src/mcp/tools.ts:361-366`; CHANGELOG entries Manager base v7, ESCALATION-BASE-V6-LISTREFUSAL01 |

The change was absorbed into the unpublished 15 instead of raising the version again, as `docs/mcp-contract.md` ("What raises it") allows. The pin moved for the added tools and for the `get_manager_mission` input.

## B. Additions

| Addition | Behaviour | Source |
| --- | --- | --- |
| `GET /api/sessions/:id/usage` | Admin token. `{ inputTokens, outputTokens }` summed over every day and model, or `null` when the ledger holds no row; unknown session 404. `null` means no data, never zero. | `packages/core/src/api/usageRoutes.ts:55-59` |
| `GET /api/projects/:id/usage/today` | Admin token. `{ dayUtc, inputTokens, outputTokens }` for the project's sessions on the current UTC day, or `null`; unknown project 404. | `packages/core/src/api/usageRoutes.ts:64-72` |
| Desktop usage display | Session total on the session card and in the manager children table; "Today (UTC)" in the project home header. Display only. | CHANGELOG entries USAGE-TOKENS-ROUTES01 (section "15"), USAGE-TOKENS-BAR01 |
| `session.failed` (WebSocket) | `{ sessionId, reason, detail? }`. | `packages/shared/src/events.ts:55`; emitted at `packages/core/src/sessions/sessionService.ts:2522` |
| `readinessDetail`, `readiness: failed` / `no_start_signal` | Last 2 KiB of the harness output (escape sequences removed, secrets masked), kept in daemon memory only. Reasons: `no_output_at_launch`, `no_start_signal`. | `packages/shared/src/session.ts:32,116`; `packages/core/src/sessions/sessionService.ts:145,2528`; `docs/launch-health.md` |
| Start delay | `firstStartTimeoutMs` of the daemon, else `startSignalTimeoutMs` of the harness, else 60 s. On expiry the session is `failed` and closed with `resume_timeout`. | `packages/core/src/sessions/sessionService.ts:144,2510-2511` |
| Hard grace after SIGKILL | 10 s (`forceKillGraceMs`); then the session is closed even if the process survives, with a `kill_failed` warning; a closed session stops counting against `children_cap` once its process is gone (up to 5 s after the failure). | `packages/core/src/sessions/sessionService.ts:147,1536-1538`; CHANGELOG entry SPAWN-START-SIGNAL-TIMEOUT01 |
| Silence check, 10 minutes | When a manager messages a live child, the daemon arms a check; at the deadline the manager gets one line starting `[scheduled event "silence_check", …]`. Not listed by `list_argus_events`, not counted in the 20-event cap. Persisted in `child_silence_checks` (migration 062); a deadline passed during a stop wakes the manager once after boot. | `packages/core/src/managers/childSilenceWatch.ts:10-11`; `packages/core/src/db/migrations/062_child_silence_checks.sql`; CHANGELOG entries CHILD-SILENCE-WAKE01, CHILD-SILENCE-PERSIST01 |
| Per-project artifact directory | `<docs folder>/artifacts/<manager>/`; a `Write` of a manager, its children and sub-agents inside it is allowed without a prompt after the daemon's checks; each judged write adds a `session_events` row (`artifact_write` or `artifact_write_refused`). `config.json` key `artifacts`: `maxFileBytes` default 256 KiB, ceiling 512 KiB; `maxProjectBytes` default 50 MiB, ceiling 1 GiB. | `packages/core/src/artifacts/artifactSettings.ts:10-13,17-20`; `docs/artifact-directory.md`; CHANGELOG entry MANAGER-ARTIFACT-WRITE01 |
| Scape import | `--json` implies a dry run (nothing written); default model alias `sonnet`; view sorts written as `orderBy`; Lexical notes converted to Markdown; a report (`import-report.md`, none for a dry run). Handling of accented names: UNVERIFIED (no accent or normalization code found in `scapeManagers.ts` or `scapeMappers.ts`; the CHANGELOG has no entry). | `packages/core/src/import/importCli.ts:43,47,103`; `packages/core/src/import/scape/scapeManagers.ts:13,55`; `packages/core/src/import/scape/scapeMappers.ts:1,245`; CHANGELOG entries on the Scape import in the section "15" |
| Worktree setup script | `scripts/worktree-setup.sh` (`pnpm install --frozen-lockfile`, `pnpm exec husky`). OpenFleet never runs it by itself; a human sets it as `postCreateHookScript` of the project. The hook script must be owned by the daemon's user, else `unsafe_permissions`. | `docs/worktrees.md` ("Setting up a fresh worktree", "Post-create hook"); `packages/core/src/git/scriptProcess.ts:42-44`; CHANGELOG entry WORKTREE-SETUP-HOOK01 |
| Base drift check | `checkBaseDrift` is a pure function run in CI by `baseDrift.repo.test.ts` (kinds `base_edited_without_bump`, `base_version_unpinned`, `duplicated_rule`); `RELEASED_BASE_SHAS` is shared with the delivery test. No runtime effect. | `packages/core/src/managers/baseDrift.ts:57`; `packages/core/src/managers/releasedBaseShas.ts:5`; CHANGELOG entry BASE-DRIFT-CHECK01 |

## C. New environment variables and options

| Name | Default | Effect | Source |
| --- | --- | --- | --- |
| `OPENFLEET_USAGE_INGESTION` | unset (off) | Only the exact value `1` turns on the recording of transcript token counts at each `Stop` hook. | `packages/core/src/usageIngestionEnv.ts:1-5`; `packages/core/src/daemonEntry.ts:16` |
| `DaemonOptions.usageIngestion` | `false` (only `true` enables) | Programmatic form of the variable. | `packages/core/src/daemon.ts:155,340` |
| `DaemonOptions.firstStartTimeoutMs` / `SessionServiceDeps.firstStartTimeoutMs` | unset; 60 000 ms applies | Start delay of every new session; wins over the harness value. | `packages/core/src/daemon.ts:147`; `packages/core/src/sessions/sessionService.ts:144,2511` |
| `Harness.startSignalTimeoutMs` | unset on the harnesses read; 60 s applies | Start delay of one harness. No non-test harness sets it: UNVERIFIED that any harness overrides the default. | `packages/core/src/harness/harness.ts:57` |
| `SessionServiceDeps.forceKillGraceMs` | 10 000 ms | Wait after SIGKILL before the session is closed anyway. Injectable, not a user setting. | `packages/core/src/sessions/sessionService.ts:36,147` |
| `config.json` `artifacts.maxFileBytes`, `artifacts.maxProjectBytes` | 256 KiB, 50 MiB | See the artifact row in B. Each field is validated alone; an invalid field takes its default with a warning; a file maximum above the quota is lowered to the quota. | `packages/core/src/artifacts/artifactSettings.ts:13,41-54` |
| `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` | forced to `0` by OpenFleet | Not a setting for the operator: the daemon overrides the environment for launches that add a read directory. | `packages/core/src/harness/claudeCli/claudeCliHarness.ts:106` |

## D. Migrations of contract 15

The last migration of contract 14 is `055_ds_row_rev`. All files are in `packages/core/src/db/migrations/`; each has a down file of the same number in `packages/core/src/db/migrations-down/`. Down scripts drop the objects and the data they hold; there is no data-preserving rollback.

| # | File | What it does | Down file |
| --- | --- | --- | --- |
| 056 | `056_escalation_ladder.sql` | Adds `projects.escalation_policy_json` and the tables `escalations`, `plan_question_batches`, `plan_questions`, `arbiter_decisions` with their indexes. | Yes: drops the four tables and the column |
| 057 | `057_escalation_handover_refusal.sql` | Adds nullable `escalations.handover_refusal_json` (JSON object). | Yes: drops the column |
| 058 | `058_session_attended.sql` | Adds `sessions.attended` (`INTEGER NOT NULL DEFAULT 0`, no backfill) and the trigger `sessions_attended_is_fixed_at_creation`. | Yes: drops trigger and column |
| 059 | `059_session_read_directories.sql` | Adds nullable `sessions.read_directories` (default `NULL`, no backfill). | Yes: drops the column |
| 060 | `060_plan_question_reopens.sql` | Adds nullable `plan_questions.reopens_batch_id` and `reopens_question_id`. | Yes: drops both columns |
| 061 | `061_plan_question_reopens_index.sql` | Adds the index `plan_questions_by_reopened_question`. | Yes: drops the index |
| 062 | `062_child_silence_checks.sql` | Creates `child_silence_checks (child_id PK, manager_id, armed_at, due_at)`, both ids referencing `sessions` with `ON DELETE CASCADE`. | Yes: drops the table |

Notes. The ladder itself is 056 and 057; 058 to 061 belong to the attended flag, the arbiter read directories and the reopen. The CHANGELOG says migration 062 may be renumbered if another branch takes that number first. A future migration that rebuilds `sessions` must recreate the trigger of 058 (`docs/escalation.md`, "Migrations that touch the sessions table"). The usage routes and the ingestion add no migration. Whether a down script has ever been run against a populated database: UNVERIFIED.

## E. What did not change

- `CONTRACT_VERSION` stays 15 (`packages/shared/src/mcpContract.ts:2`); the pin file reads `"contractVersion": 15` (`packages/core/src/mcp/contract.pinned.json:2`).
- The pin (`packages/core/src/mcp/contract.pinned.json`) covers 72 tools by input-schema hash (entries at lines 4 to 75). It is the tools a manager sees; the reviewer's set is a subset (`docs/mcp-contract.md`, "The guard test").
- `get_manager_mission` has its own hash, `16debab900739aa3` (pin line 24). `get_argus_status` shares `7a014b717a77aac9` with `get_argus_governance`, `list_argus_events`, `list_children`, `list_projects`, `list_sessions` and `list_watched_prs` (pin lines 20, 21, 31, 32, 38, 40, 41): its input did not change, only its answer.
- `submit_plan_questions` (`853b07a9f080c87e`), `report_arbiter_opinion` (`76fc5d7354afaa7d`) and `approve_plan_criteria` (`3a770ff3fba7ad08`) are pinned (pin lines 6, 52, 64). The `reopens` parameter did not move the pin because the questions are an array of objects the daemon parses.
- The guard hashes input schemas only. Every output change on this page (the `get_argus_status` answer, `readinessDetail`, `session.failed`) is recorded by hand (`docs/mcp-contract.md`).
- The REST views of managers and sessions keep their shape, except the read-only `Session.attended` (present as `true`, absent otherwise).

## F. Known limits worth reading before the switch

| Limit | Where it is written |
| --- | --- |
| A session that closes inside its one-second ingestion window loses its last `Stop`: the tokens of its last turn are not recorded. | `docs/usage-ledger.md` ("Known limits") |
| An agent can forge its own usage by writing assistant lines with any token counts into its own transcript (within the stated caps); the forgery reaches the session, project, billing code and global sums. Nothing is billed from this ledger. | `docs/usage-ledger.md` ("Known limits") |
| A refused message (timestamp window, bucket budget, session maximum) is lost; the cursor lives in memory and is lost at a daemon restart, after which the transcript is re-read from its start under the same cap. | `docs/usage-ledger.md` ("Ingestion") |
| The ingestion bound is per session, not global; the hook endpoint has no rate limit. | `docs/usage-ledger.md` ("Known limits") |
| Resume and reopen are not checked by the binary check or the launch watchdog; a `pending` readiness survives a restart. | `docs/launch-health.md` ("Known limits") |
| The arbiter negative claims (the added worktree's `CLAUDE.md` and skills are not loaded) rest on one live sample with Claude Code CLI 2.1.308, by model self-report. The `CLAUDE.md` of parent directories of `OPENFLEET_HOME` is still loaded. Re-run the canary on every CLI upgrade. | `docs/escalation.md` (Limits) |
| The floor classes are a heuristic on `paths` and keywords; the daemon does not read the ticket's git diff. | `docs/escalation.md` ("What the floor classes are and are not", Limits) |
| An arbiter created during a shutdown whose single close fails stays live until the next boot. | `docs/escalation.md` (Limits) |
| Artifact grant: the judgement and the write are not atomic, a write through `Bash` is not covered, two manager names that differ only by characters outside the allowed set share a directory. | `docs/artifact-directory.md` ("Limits") |
| Silence check: a reviewer's `go` verdict sends no message and does not cancel it; several silent children wake the manager once each; a check skipped because the child changed state recently is not re-armed. | CHANGELOG entry CHILD-SILENCE-WAKE01 |
| Scape import of `get_argus_status` references: only three phrasings are rewritten to `get_manager_mission`; other forms keep the old name. | CHANGELOG entry on the Scape import rewrite, section "15" |
| The live ask-user canary was played once (CLI 2.1.308) and writes trust entries into the real user configuration. | `docs/escalation.md` (Limits); CHANGELOG entry ESCALATION-LIVE-CANARY01 |

## Not found in the code

- Accented-name handling of the Scape import (section B).
- Any harness that sets `startSignalTimeoutMs` (section C).
- A link or docs check script: no file under `scripts/` matches; the only docs script is `docs:errors` (`package.json:14`), which generates the error reference and does not check links.
