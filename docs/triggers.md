# Triggers: the engine

A trigger is one WHEN source, up to 32 conditions, one RUN action and a policy (`packages/shared/src/triggers.ts`). A human arms it in the desktop app; every edit clears the arming. The engine (`packages/core/src/triggers/`) fires the armed ones. The record of what changed is in the section "15" of `CHANGELOG.md`.

## What is guaranteed

**At most once per (trigger, dedup key).** The ledger table `trigger_fires` has `UNIQUE (trigger_id, dedup_key)`. The same event offered twice by a source, or after a restart, is one fire. This is not exactly once: a fire whose effect may or may not have happened is never replayed, and a message queue can still deliver a message late. No other text of the project may claim exactly once.

## The ledger

| step | state written | when |
|---|---|---|
| the event passes the armed check and the conditions | `accepted` | before anything happens for it |
| the policy and the breaker let it through | `attempted` | just before the effect |
| the effect ran | `completed` | after it |
| a rule held it back, or the effect could not run | `cancelled` + reason | instead of the two above |
| the daemon stopped while it was `attempted` | `needs_review` + `interrupted` | at the next boot |

At boot, a fire still `accepted` is judged again: `disarmed` when the trigger is no longer armed as it was approved, `stale` when it is older than the backlog age, `superseded` when `fire_latest_only` keeps a newer one; the others pass through the policy again. The age is `backlogMaxAgeMinutes`; without it `fire_all` and `fire_latest_only` keep every fire and `discard_stale` keeps the last 60 minutes.

A crash test cannot stop the process between two lines of synchronous code. The tests write the row a killed daemon would leave (`attempted`), restart the daemon on the same home, and read the ledger and the message queue.

## Policy and breakers

- `cooldownSeconds`: counted from the effect of the previous fire of the trigger. With `batchMode: per_batch` the fires that arrive during the cooldown wait as `accepted`; when it ends, the newest runs with `batch=N` in its header and the older ones are cancelled `batched`.
- `maxFiresPerDay`: effects started in the local day. The ledger stamps `effect_started_at` in the same statement that writes `attempted`, and the count reads that stamp (states `attempted`, `needs_review` and `completed`), not the date the fire was accepted: a fire held across midnight counts on the day it runs.
- Breaker: 30 effects started per minute for the whole daemon. The 31st fire is cancelled `breaker_open`, its trigger is disarmed, the Inbox gets the error code `breaker_open` (a broadcast `error` event). The counter lives in memory and starts again at zero at every boot.
- Chain depth: the cause of an event is found with the message a fire sent: its id is the id of the fire, so the message queue says which session a fire prompted. An event about that session, or about one of its children, within 60 minutes, makes a fire of depth 2. A depth above 2 is cancelled `chain_depth`. The 60 minutes are a heuristic: an event that has nothing to do with the message can be counted as its effect, and a late one is missed.
- Arming rescans the sessions already in the state. The rescan is not capped on the side of the registry (every session that matches is offered); the effects are capped by the policy and the breaker.
- Fires are kept: there is no 90-day retention yet.

## The owner of a trigger

A trigger has an owner, `owner_manager_id`: a manager, the root of a lineage, or none. A trigger created by an MCP tool gets the lineage root of the calling session. A trigger created with the REST API names its owner or `null` (`ownerManagerId` is required in the body). The owner is part of the approved graph: changing it clears the arming and changes the digest.

- `session_state` only watches the children whose lineage root is the owner. A trigger with no owner watches the children of every manager of its project, and may only `prompt_manager` and `notify`.
- `close_session` closes a child of the owner only, and only when the event is about a child of the same owner. Anything else is cancelled `target_not_eligible`, and the target stays active.
- `prompt_session` reaches a session of the project in the lineage of the owner (the owner included). A trigger with no owner, or a target outside the lineage, is cancelled `target_not_eligible`.

## What a message holds

The header is written by the daemon from ids and enumerations. The prompt, with the tokens of the allow-list filled in, sits inside the envelope marked untrusted. A record value never reaches the header. See `docs/notification-events.md` for the banner of `notify`.

## Sources

`session_state` is the only source the engine runs. A wait that ends while the daemon is stopped is not lost. A daemon that stops cleanly writes its pending waits to `trigger_cursors`; at boot the source captures the sessions as the database holds them before `resumeAll` (resuming writes a new state time), and reads the cursors and offers the episodes after it. The episodes come from those cursors and from the captured sessions a killed daemon left idle or on a permission prompt; the ones already due are offered with their real deadline as the date of the fire. A cursor is handed back to the trigger it was written for and to no other; an episode read from a session is offered to every trigger that watches it. A cursor date must be an ISO 8601 date with a time and an offset (`2026-11-02T10:00:00.000Z`); an episode with any other date is ignored. Reading the cursors deletes only those that parse: a cursor that is not valid JSON is logged and left in place, so it does not cost the other triggers their episodes, and the next clean stop of that trigger overwrites it. The backlog policy judges them like the fires left `accepted`: `fire_all` fires each, `fire_latest_only` keeps the latest, `discard_stale` cancels as `stale` what is older than `backlogMaxAgeMinutes` (60 by default) counted from the deadline. An episode already fired is a duplicate. A session that closed with an error while the daemon was stopped, after the trigger was armed, is offered once. A wait not yet due at boot is not restored: resuming starts a new episode.

`silent_run`, `data_store_query`, `cron` and `integration_records` are accepted by the schema and do not fire yet. The RUN `run_playbook` does not run either.
