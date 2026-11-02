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
- `maxFiresPerDay`: fires that reached their effect since local midnight.
- Breaker: 30 effects started per minute for the whole daemon. The 31st fire is cancelled `breaker_open`, its trigger is disarmed, the Inbox gets the error code `breaker_open` (a broadcast `error` event). The counter lives in memory.
- Chain depth: the cause of an event is found with the message a fire sent: its id is the id of the fire, so the message queue says which session a fire prompted. An event about that session, or about one of its children, within 60 minutes, makes a fire of depth 2. A depth above 2 is cancelled `chain_depth`.

## What a message holds

The header is written by the daemon from ids and enumerations. The prompt, with the tokens of the allow-list filled in, sits inside the envelope marked untrusted. A record value never reaches the header. See `docs/notification-events.md` for the banner of `notify`.

## Sources

`session_state` is the only source the engine runs. `silent_run`, `data_store_query`, `cron` and `integration_records` are accepted by the schema and do not fire yet. The RUN `run_playbook` does not run either.
