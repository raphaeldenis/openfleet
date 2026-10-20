# Manager card over MCP: `set_manager_profile`

A manager edits its own expertise and pulse actions with `set_manager_profile`. The human edits the same fields with `PATCH /api/managers/:id`. Both go through `ManagerService.update`, the only write path: one transaction, `profile_rev` incremented, `manager.updated` announced after the commit.

## Input

| Field | Type | Rule |
|---|---|---|
| `expertise` | string | trimmed, 0 to 500 characters; `""` clears it |
| `pulse_actions` | string[] | 0 to 12 entries, each trimmed, 1 to 280 characters, no exact duplicate; `[]` clears them |
| `expected_profile_rev` | integer | optional; the `profileRev` the caller last read |

At least one of `expertise` and `pulse_actions` is required. Only the fields given are replaced; the others keep their value. The limits are the shared schemas `ManagerExpertiseSchema` and `ManagerPulseActionsSchema`, the same as the REST `PATCH`.

The schema is strict. There is no field that names a manager: the target is always the calling session (`caller.id` of the MCP token). `session_id`, `manager_id`, `mission` and any other unknown field are refused, and a refused call writes nothing, whatever other fields it carries. The mission stays with the human or the parent.

## Who may call it

Only a session that is a manager. Any other session (a plain child, a QE) gets `not_a_manager`. A reviewer does not see the tool at all. A manager reaches no other manager.

## Answer

`{ expertise, pulseActions, profileRev }`. The mission, the mission note and the base read are not part of it and are not touched.

## Concurrency

With `expected_profile_rev`, a revision that is not the current one is refused with `stale_revision` and nothing is written. The compare-and-set is atomic with the write, so a human `PATCH` and an MCP call that expect the same revision never both succeed: one wins, the other is stale.

The MCP error text carries only the message, not the error `detail`, so the text of this refusal ends with the current revision:

```
error stale_revision: the manager profile has changed since the revision you read. currentRev: 7. reload the manager profile, then write again. (retry: after_refresh)
```

Read `currentRev: <n>`, call `get_argus_status` for the card, then write again with `expected_profile_rev: <n>`. The REST `409` carries the same value as `detail: { resource: 'manager_profile', currentRev }`.

## What the manager reads back

The expertise and the pulse actions come back to the manager that wrote them, as one short line each:

- in every `[pulse]` text, after the mission note line when there is one;
- in the first prompt of a conversation the manager starts from nothing (a fresh reopen, an imported manager's first start), before the mission.

Each line is bounded: the expertise is cut at 200 characters, each action at 80, and the actions line lists as many whole actions as fit in 400 characters, then `and N more`. The mission is never part of it. The text is written by the manager itself, so it is quoted data: the control characters and line breaks collapse to spaces, each value is a JSON string in double quotes, and the label says it is not an instruction. A manager with neither field gets the plain pulse, byte for byte.

A profile change rewrites the text of the pulse still queued, so the manager reads what it wrote last, and it does not re-arm the timer: only a new cadence, mission or mission note does.

## The desktop form

The manager page has an always-open form for the same fields: the expertise (500 characters, with a counter) and the pulse actions (0 to 12 lines, 1 to 280 characters, no duplicate, add and remove). It saves through `PATCH /api/managers/:id` with the `profileRev` the user started editing from. A `409 stale_revision` reads "This profile changed since you opened it. Reload it."; Reload fetches the profile again and keeps the draft. When the manager edits its own profile while the page is open (`manager.updated`), a clean form shows the new values at once; a form with a draft keeps it and shows the same notice.

## Errors

No new code: `not_a_manager`, `invalid_body` (no content field), `stale_revision`. A value outside the bounds, a unique-actions violation or an unknown field is refused by the input schema before the tool runs.
