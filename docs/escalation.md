# Escalation ladder: the human side

A manager submits its plan questions with `submit_plan_questions`. The daemon routes each question by class. The questions that need a human of one ticket make **one** escalation, which a human answers over REST. This page covers the escalation record, the REST routes, the WebSocket events and the snapshot. The design is in `specs/2026-10-29-escalation-ladder-design.md` (outside the repository).

## The escalation

An escalation belongs to one manager and one ticket. At most one escalation is `pending` per manager and ticket: a later batch of the same ticket that holds an escalating question joins it, and the daemon rebuilds its body. The body is written by the daemon, never by the manager: header, then each question with its classes, options and the recommendation of the manager. It is plain text, secrets masked, at most 2000 characters.

The manager finds one item `[esc:<id>] Escalation on <ticket>: …` in its `questions_for_human`. The item is written once and never edited.

`submit_plan_questions` answers `{ batch_id, self, arbiter, human, warnings? }`. When the `questions_for_human` list is full (20 items), the answer is still ok: the batch is committed, the questions wait on the card with its `handoverRefusal`, and `warnings` holds `["list_refusal: <refusal> <hint>"]`. The call used to be refused `invalid_body`. A manager that reads the warning does not submit the questions again; a human answers the card or retries the listing (`retry-handover`). The manager base template (v6, §6) and the tool description both say so.

`EscalationView` (`@openfleet/shared`):

| Field | Meaning |
|---|---|
| `id`, `managerId`, `ticket` | identity |
| `status` | `pending` or `answered` |
| `body` | the text the daemon rendered |
| `createdAt`, `resolvedAt?` | ISO timestamps |
| `handoverRefusal?` | `{ reason, refusal, hint?, at }`, set while the card could not be listed in the manager's `questions_for_human` (the list holds 20 items) after the arbiter was unavailable or its quota was used up. The questions wait on the card, and a human can answer it or retry the listing |
| `questions[]` | `questionId`, `text`, `declaredClass`, `effectiveClasses`, `reason?` (`unclassified`), `options?`, `recommendation?`, `status` (`pending_human` or `answered`), `humanAnswer?`, `answeredAt?` |

## REST

Every route sits under `/api`: it needs the admin token. The token of a session (the one `/mcp` accepts) gets `401 unauthorized`. No escalation route exists under `/mcp`: only a human closes an escalation.

| Route | Answer |
|---|---|
| `GET /api/escalations?status=pending\|answered` | `EscalationView[]`, oldest first. `status` defaults to `pending`. Any other value is refused `invalid_body` (400). |
| `GET /api/managers/:id/escalations` | the escalations of that manager, all statuses. `manager_not_found` (404) for a session that is not a manager. |
| `POST /api/escalations/:id/answer` | body `{ answers: [{ question_id, answer }] }` → the answered `EscalationView`. |
| `POST /api/escalations/:id/retry-handover` | no body → the `EscalationView`, listed in the manager's `questions_for_human`, `handoverRefusal` cleared. Refused `invalid_body` (400) while the list is still full (the card keeps `handoverRefusal`) or when the hand-over was not refused; `already_resolved` (409), `escalation_not_found` (404). Nothing retries by itself. |

`answer` rules:

- One answer for **each** question still pending in the escalation, no more, no fewer, each `question_id` once. Otherwise `invalid_body` (400), and nothing is answered.
- `answer` is trimmed, 1 to 2000 characters. It is stored with invisible characters removed and secrets masked.
- Unknown escalation: `escalation_not_found` (404). Already answered: `already_resolved` (409), the first answers stay.
- The answer is atomic: the questions and the escalation change in one transaction.

When the answer is committed, the daemon sends the manager one message, `Escalation <id> on <ticket> answered. q1: … | q2: …` (secrets masked, at most 2400 characters). It is skipped when the manager session is closed.

## WebSocket

| Event | When | Payload |
|---|---|---|
| `escalation.raised` | an escalation is opened, and again each time a later batch of the ticket joins it | `{ escalation }`, the full `EscalationView` (upsert it by `id`) |
| `escalation.resolved` | a human answered | `{ escalation }` |

A batch that needs no human emits nothing. A refused answer emits nothing.

`snapshot.escalations` holds the `pending` escalations, `[]` when none. A daemon that predates the field omits it.

## What the floor classes are and are not

The floor classes (`computeFloorClasses`) are a heuristic on paths and keywords. They lower the risk that a question escapes the human list by a wrong label. They do not detect meaning: a question reworded outside the keywords and outside the touched paths is routed by the class the manager wrote. The arbiter and the review of the escalation journal are the second line. A false positive costs one grouped human question; it is fixed by removing the faulty rule in the project setting (a human action), never by the manager.

## Limits

- Two batches of one ticket that reuse the same `question_id` in the same open escalation share one answer: the answer applies to both.
- When a human answers an escalation, the daemon removes its `[esc:<id>]` item from the `questions_for_human` of the manager and leaves every other item untouched; it does nothing when the item is already gone or the manager has no working state. The desktop UI also hides the `[esc:<id>]` items of every escalation it knows, open or answered, so the card disappears at once, and shows the items of an id it does not know. The desktop learns an answered escalation from the `escalation.resolved` event received while it is connected (the snapshot lists only the pending ones); after a reload the daemon removal is what keeps the answered item away.
- The arbiter's decision binds. The reopening of a decision (one reopen with new evidence, then an `arbiter_dispute` to the human, decision F8A of the design) is not built: a manager that disagrees with the arbiter raises it to the human through a new question of an escalating class.
- The touched paths of a question are the `paths` the manager provides, and only those. The daemon does not read the git diff of the ticket worktree, so a file the plan touches but the manager does not list is not scanned by the floor classes.
- The ticket is an identifier of letters, digits, dots, underscores and hyphens, at most 40 characters; any other text is refused with `invalid_body`.
- A manager is **attended** only when a human created it with the `attended` flag (`POST /api/sessions` with the admin token, a manager without parent; the desktop "New manager" form has an unchecked box). The flag is stored on the session, fixed at creation (no tool, route or database update changes it; a trigger refuses the update) and shown read-only as `attended: true` in the session view. A manager created through MCP `create_session` is never attended.
- Every other manager is supervised, the desktop-created ones included: the daemon refuses its `AskUserQuestion`, in 'observe' as in 'enforce' mode (the guard is `managerAskUserGuard`, outside the command policy mode, which keeps governing every other rule). The refusal points to `submit_plan_questions` and says a human can recreate the session as attended. It is journaled once, `denied`, rule `manager-ask-user-via-ladder`. An attended manager keeps `AskUserQuestion`; each call is journaled `observed`, rule `root-manager-ask-user`.
- **Upgrade effect**: the managers that exist before migration 058 have `attended = 0` and become supervised. Upgrade: a live manager that must keep AskUserQuestion is recreated with the box ticked.
- The "attended" checkbox of the desktop "New manager" form is specified in jsdom and not verified in a browser (ESCALATION-ATTENDED-QA01).
- On a daemon shutdown, the arbiter whose creation resolves after `stop()` gets one close attempt and no retry. If that close fails, the arbiter stays live until the next boot, where `recover()` closes every live arbiter it does not track: the leak is bounded to one daemon run. After `stop()`, `launch()` and a lost arbiter start nothing and escalate nothing.
- The arbiter starts in a neutral working directory: an empty directory of its own (`<OPENFLEET_HOME>/arbiter-workspaces/arbiter-<random>`, mode 0700). What the CLI loads from the directories around it, measured with claude 2.1.308 on 2026-10-30 (re-check on every CLI upgrade):
  - The `CLAUDE.md` of the added worktree is loaded only when `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`. OpenFleet forces `0` in the environment of every launch that adds a read directory, whatever the daemon environment says. A user-level `settings.json` `env` block may still set it: accepted residual.
  - The skills of the added worktree (`.claude/skills`) are not loaded, because the harness launches with `--setting-sources user`.
  - The `CLAUDE.md` files of the **parent** directories of the working directory are loaded by the CLI. Keep `OPENFLEET_HOME` outside any repository: inside one, the `CLAUDE.md` of that repository would reach the arbiter.

  It reads the worktree of the ticket (else the manager's directory) through `--add-dir=<real path>`: the daemon resolves symlinks first, and the harness refuses a path that is not absolute. `readDirectories` is set by the daemon only; `POST /api/sessions` refuses a body that carries it (`invalid_body`, admin token included) and the `create_session` tool does not read it. The daemon removes the directory when the arbiter closes (opinion, expiry, human close, launch failure) and sweeps the unused ones at `recover()`; a daemon shutdown keeps it so the arbiter can be resumed.
- A **resumed** arbiter (after a daemon restart or a reopen) keeps its `--add-dir`: the daemon stores the read directories (real paths) in `sessions.read_directories` (migration 059, JSON array, `NULL` for every other session and every session that existed before) when it creates the arbiter, and passes them again at every relaunch. At relaunch each stored path is re-checked: it must still be a directory and still be its own real path (a path that vanished, became a file or now goes through a symlink is dropped, never followed). When none is left the arbiter resumes with its neutral working directory only. The column is read by the launch only: it is not in `Session`, the REST and WebSocket views, the MCP tools or the logs, and the REST route still refuses a body that carries `readDirectories`. `recover()` is unchanged.
- The negative claims above (the `CLAUDE.md` and the skills of the added worktree are not loaded) are measured by model self-report, not a file trace, and not by a live canary until someone runs one. The opt-in canary launches the real CLI from an empty directory with the arbiter flags and plants a marker instruction in the `CLAUDE.md` of the added folder, in the `CLAUDE.md` of its parent folder, and a project skill in the added folder (temp directories, markers built at run time; a user-level skill is not covered, since planting one would touch the real `~/.claude`). It reads the real user configuration and spends a few turns on the cheapest model. Acceptance command: `pnpm --filter @openfleet/core test:live -t "arbiter launch flags"` (the script sets `OPENFLEET_LIVE=1`; without it the vitest config does not collect the file). Record the claude version and the date of the run here; the claim above stays "model self-report" until then.

## Migrations that touch the sessions table

The repository has no contributor migration guide, so this rule lives here. A future migration that rebuilds the `sessions` table (create new, copy, drop, rename) or that uses `REPLACE INTO sessions` must recreate the trigger `sessions_attended_is_fixed_at_creation`: `REPLACE` deletes the row and inserts a new one, so it does not fire a `BEFORE UPDATE` trigger and would silently change `attended`; a dropped table takes its triggers with it. Migration `058_session_attended.sql` defines the trigger to copy. Migration `059_session_read_directories.sql` is a plain nullable `ADD COLUMN` (`sessions.read_directories`, default `NULL`, no backfill, no trigger); its down file drops the column, and a rebuild of the table must carry it over.
