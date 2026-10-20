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

## Errors

No new code: `not_a_manager`, `invalid_body` (no content field), `stale_revision`. A value outside the bounds, a unique-actions violation or an unknown field is refused by the input schema before the tool runs.
