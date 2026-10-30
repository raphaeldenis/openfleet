# Escalation ladder: the human side

A manager submits its plan questions with `submit_plan_questions`. The daemon routes each question by class. The questions that need a human of one ticket make **one** escalation, which a human answers over REST. This page covers the escalation record, the REST routes, the WebSocket events and the snapshot. The design is in `specs/2026-10-29-escalation-ladder-design.md` (outside the repository).

## The escalation

An escalation belongs to one manager and one ticket. At most one escalation is `pending` per manager and ticket: a later batch of the same ticket that holds an escalating question joins it, and the daemon rebuilds its body. The body is written by the daemon, never by the manager: header, then each question with its classes, options and the recommendation of the manager. It is plain text, secrets masked, at most 2000 characters.

The manager finds one item `[esc:<id>] Escalation on <ticket>: …` in its `questions_for_human`. The item is written once and never edited.

`submit_plan_questions` answers `{ batch_id, self, arbiter, human, warnings? }`. When the `questions_for_human` list is full (20 items), the answer is still ok: the batch is committed, the questions wait on the card with its `handoverRefusal`, and `warnings` holds `["list_refusal: <refusal> <hint>"]`. The call used to be refused `invalid_body`. A manager that reads the warning does not submit the questions again; a human answers the card or retries the listing (`retry-handover`). The manager base template (v5) does not yet mention `list_refusal`; the tool description does. A base v6 bump is tracked as ESCALATION-BASE-V6-LISTREFUSAL01.

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
- **Upgrade effect**: the managers that exist before migration 058 have `attended = 0` and become supervised. A live Lead that must keep `AskUserQuestion` has to be recreated with the box ticked.
- The arbiter starts in the ticket worktree or the manager's directory; neutral cwd with read access is tracked in ESCALATION-ARBITER-NEUTRAL-CWD01.
