# Escalation ladder: the human side

A manager submits its plan questions with `submit_plan_questions`. The daemon routes each question by class. The questions that need a human of one ticket make **one** escalation, which a human answers over REST. This page covers the escalation record, the REST routes, the WebSocket events and the snapshot. The design is in `specs/2026-10-29-escalation-ladder-design.md` (outside the repository).

## The escalation

An escalation belongs to one manager and one ticket. At most one escalation is `pending` per manager and ticket: a later batch of the same ticket that holds an escalating question joins it, and the daemon rebuilds its body. The body is written by the daemon, never by the manager: header, then each question with its classes, options and the recommendation of the manager. It is plain text, secrets masked, at most 2000 characters.

The manager finds one item `[esc:<id>] Escalation on <ticket>: …` in its `questions_for_human`. The item is written once and never edited.

`EscalationView` (`@openfleet/shared`):

| Field | Meaning |
|---|---|
| `id`, `managerId`, `ticket` | identity |
| `status` | `pending` or `answered` |
| `body` | the text the daemon rendered |
| `createdAt`, `resolvedAt?` | ISO timestamps |
| `questions[]` | `questionId`, `text`, `declaredClass`, `effectiveClasses`, `reason?` (`unclassified`), `options?`, `recommendation?`, `status` (`pending_human` or `answered`), `humanAnswer?`, `answeredAt?` |

## REST

Every route sits under `/api`: it needs the admin token. The token of a session (the one `/mcp` accepts) gets `401 unauthorized`. No escalation route exists under `/mcp`: only a human closes an escalation.

| Route | Answer |
|---|---|
| `GET /api/escalations?status=pending\|answered` | `EscalationView[]`, oldest first. `status` defaults to `pending`. Any other value is refused `invalid_body` (400). |
| `GET /api/managers/:id/escalations` | the escalations of that manager, all statuses. `manager_not_found` (404) for a session that is not a manager. |
| `POST /api/escalations/:id/answer` | body `{ answers: [{ question_id, answer }] }` → the answered `EscalationView`. |

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
- The `[esc:<id>]` item stays in `questions_for_human` after the answer; the manager removes it with `update_working_state`.
