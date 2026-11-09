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
- Retention: the ledger forgets the event of a `completed` or `cancelled` fire 90 days after it ended (`settled_at`). Forgetting empties `event_json` (`{}`) and keeps the row: id, trigger, dedup key, state, dates, effect time and chain depth stay. The row is the witness that the event was handled: the unique `(trigger_id, dedup_key)` still answers the fire already settled when a source offers the same event again (a `closed_with_error` session that stays closed, a `fire_all` backlog without a maximum age), so a forgotten event never runs twice; and a cooldown still counts the effect of a forgotten fire, whatever the retention (a 120-day cooldown under a 90-day retention holds for 120 days). A fire that is `accepted`, `attempted` or `needs_review` keeps its event, however old. The cost is a few hundred bytes per fire, kept as long as the trigger; there is no row cap, the retention is by age only. The purge runs at boot, after `recover()`, and then every 24 hours on the scheduler of the daemon (`triggers.schedule`, stopped with the daemon), whether or not a fire settles. It handles 1000 rows at most per statement, continues after the last row it handled, hands the event loop back between two batches, and ends at the first batch that is not full. The number of days is `triggers.fireRetentionDays` in `config.json` (whole number, 1 to 3650, default 90; a value outside the range, or an unknown key in `triggers`, refuses the boot). A failed purge is logged as a warning and never stops the boot or a fire. Cost, measured by `fireRetention.cost.test.ts`: 70 000 of 100 000 events forgotten in 71 batches, none of them holding the event loop for more than one batch.

## The digest to review before arming

`GET /api/triggers` and `GET /api/triggers/:id` add `reviewDigest` to each trigger: the digest of the approved graph (owner, WHEN, conditions, RUN, policy) of the trigger as it stands. It comes from `reviewDigestOf`, the function arming uses to record `approvedGraphDigest` and the engine uses to judge a fire, so a trigger armed and left unchanged reads `reviewDigest === approvedGraphDigest`. The title is not part of it. Reading writes nothing: no revision, no arming, no activity log row. The RUN holds the id of a playbook, not its content: the digest follows the id and the inputs, and an edit of the playbook disarms the triggers that run it (see "The RUN `run_playbook`"). The MCP tools do not return it.

## The owner of a trigger

A trigger has an owner, `owner_manager_id`: a manager, the root of a lineage, or none. A trigger created by an MCP tool gets the lineage root of the calling session. A trigger created with the REST API names its owner or `null` (`ownerManagerId` is required in the body). The owner is part of the approved graph: changing it clears the arming and changes the digest.

- `session_state` only watches the children whose lineage root is the owner. A trigger with no owner watches the children of every manager of its project, and may only `prompt_manager` and `notify`.
- `close_session` closes a child of the owner only, and only when the event is about a child of the same owner. Anything else is cancelled `target_not_eligible`, and the target stays active.
- `prompt_session` reaches a session of the project in the lineage of the owner (the owner included). A trigger with no owner, or a target outside the lineage, is cancelled `target_not_eligible`.

## What a message holds

The header is written by the daemon from ids and enumerations. The prompt, with the tokens of the allow-list filled in, sits inside the envelope marked untrusted. A record value never reaches the header. See `docs/notification-events.md` for the banner of `notify`.

## Sources

The engine runs four sources: `session_state`, `data_store_query`, `cron` and `silent_run`. For `session_state`, a wait that ends while the daemon is stopped is not lost. A daemon that stops cleanly writes its pending waits to `trigger_cursors`; at boot the source captures the sessions as the database holds them before `resumeAll` (resuming writes a new state time), and reads the cursors and offers the episodes after it. The episodes come from those cursors and from the captured sessions a killed daemon left idle or on a permission prompt; the ones already due are offered with their real deadline as the date of the fire. A cursor is handed back to the trigger it was written for and to no other; an episode read from a session is offered to every trigger that watches it. A cursor date must be an ISO 8601 date with a time and an offset (`2026-11-02T10:00:00.000Z`); an episode with any other date is ignored. Reading the cursors deletes only those that parse: a cursor that is not valid JSON is logged and left in place, so it does not cost the other triggers their episodes, and the next clean stop of that trigger overwrites it. The backlog policy judges them like the fires left `accepted`: `fire_all` fires each, `fire_latest_only` keeps the latest, `discard_stale` cancels as `stale` what is older than `backlogMaxAgeMinutes` (60 by default) counted from the deadline. An episode already fired is a duplicate. A session that closed with an error while the daemon was stopped, after the trigger was armed, is offered once. A wait not yet due at boot is not restored: resuming starts a new episode.

`data_store_query` reads the change history of a data store (`ds_row_history`) from a position kept in `trigger_cursors`, `{ kind: 'table', seq, count, tooLarge }`, one row per trigger: `seq` is the last change dealt with, `count` the row count of the store at that change, `tooLarge` the number of changes not offered because their event was too large. It does not run queries.

| `event` | fires | event the conditions read |
|---|---|---|
| `new_matching_rows` | for each row created, when the conditions hold | `event.row.<columnId>`, `event.row.id` |
| `row_updated` | for each write that changed cells, when the conditions hold | `event.row.<columnId>` (the row as it stands when the source reads the change), `event.previous.<columnId>` (the value before, for the cells that changed only) |
| `row_count` | once for each change of the journal that takes the row count of the store to `op` / `value` from a count that was off it (edge, false to true), counted creation by creation and deletion by deletion in the order of `seq`; the offer is dated by that change and its dedup key is `row_count:<seq of that change>` | `event.row.count` (the count after that change) |

- Starting point: arming puts the cursor at the end of the history (never behind where it was), so rows written before arming, or while the trigger was disarmed, are not offered. The cursor never goes back. A row count that already meets the threshold at arming does not fire.
- Restart: the changes written while the daemon was stopped are offered at boot, with the date of each change, so the backlog policy judges their age. The dedup key is `row:<history id>` (`row_count:<seq>` for a count), so a change read twice is one fire.
- Pages and crashes: the history is read 200 changes at a time. A page is offered to the engine (the ledger row of each fire is written, `UNIQUE (trigger_id, dedup_key)`), and only then does the cursor move past it. A daemon that stops between the two reads the page again at the next start and the ledger absorbs it: no offer is lost and none fires twice. The two writes are not one transaction; the order is what makes it safe.
- Budget: one run reads at most `MAX_PAGES_PER_RUN` (10) pages and offers exactly at most `MAX_OFFERS_PER_RUN` (500) changes (the last page is cut to what is left of the budget), then a timer (`NEXT_TICK_DELAY_MS`) resumes from the cursor, so a history of thousands of changes does not hold the daemon. There is one tick at a time per trigger.
- Catch-up: at boot, a trigger whose cursor is behind the history starts a catch-up that ends at the last change of the history at that moment. Until it reaches that change, every run judges the changes as a backlog (backlog policy, age, `fire_latest_only`, budget); a live write that arrives meanwhile is left to the next tick and does not spend the rest of the backlog as single offers. After that change the trigger reads live writes again. A run that exhausts its budget on live writes also becomes a catch-up, to the last change at that moment. With `fire_latest_only` a run keeps in memory the latest offer whose conditions hold, and offers that one at the end of the run: a history longer than one run gives one fire per run, not one for the whole backlog. An event of more than 8192 characters is not offered; it is logged and counted in `tooLarge` of the cursor. Other policies are judged page by page.
- Loop guard, by cause: the journal knows an agent as "<emoji> <session name>" only. A write by an agent is attributed to a trigger when a session of that name, or one of its ancestors, received a message of a fire of that trigger (the message id is the fire id) in the 60 minutes before the write (`CHAIN_CAUSE_WINDOW_MINUTES`, the window of the chain depth). The trigger that sent the message is never offered that write (the activity log gets a `trigger.offer_suppressed` row with the trigger id, no text); any other trigger is offered it at a chain depth one above the deepest cause, so the cap of 2 applies (`chain_depth`). A write by a human is never attributed. All the sessions that carry the label are considered. A write made while the source reads is read in the next turn, not inside the current one.
- Known limits of the attribution, accepted: (1) a slow loop, where the manager writes more than 60 minutes after the message of the trigger, is no longer attributed and starts again at chain depth 0. (2) The label of the author is read when the source reads the change: a session renamed between its write and that reading is not found under its old label. For both, the bound that remains is the global breaker (30 effects started per minute, the 31st fire is cancelled `breaker_open` and its trigger is disarmed) and `maxFiresPerDay`. (3) The author is found by project: only the sessions of the project of the store are considered, so a namesake in another project causes nothing.
- The date of the cause is the date the message was queued (`message_queue.created_at`), not the date of the event of the fire: a fire made while the daemon was stopped, or held back by a cooldown, and sent later still causes the writes that follow its message.
- Over-suppression, on purpose: the window is the one of the chain depth, not "the current turn", because the daemon keeps no history of the states of a session. A manager that a trigger T prompted, and that then writes a row for a reason of its own within the hour, has that row attributed to T: T is not offered it. Example: T watches the table "Incidents" and prompts the manager "Lead"; Lead triages an incident, then 20 minutes later adds an unrelated incident row by hand through the tool; T does not fire for that row. The error is on the safe side (a missed fire, never a loop); a human writing in the table does fire T.
- Scope: the store must belong to the project of the trigger, otherwise nothing is offered. Data stores are shared at the level of the project: the rows have no lineage boundary, so any session of the project may write a row a trigger of another lineage watches. The owner scopes what the trigger does, not what it reads: with an owner, the RUN `prompt_manager` reaches the owner when it names no manager, a named manager outside the lineage of the owner cancels the fire as `target_not_eligible`, and so does an owner that is no longer a manager (fail closed). An event of a table has no session: `close_session` is cancelled `target_not_eligible`.
- Text: the prompt takes no token from a row (the allow-list of `data_store_query` is empty), the header holds ids only, and the row is not written to the activity log. The event, with the cells, is kept in the ledger row of the fire (`event_json`, 8192 characters at most). `row_updated` reads the row as it stands when the source reads the change, not as it was at that change: a later write can show in `event.row`; `event.previous` holds only the values before this change.
- Conditions read column ids, not display names.

## Source `cron`

A cron trigger fires at the slots of a five-field expression (`minute hour day-of-month month day-of-week`) read in an IANA time zone. No dependency is used: the parser is `packages/shared/src/cronExpression.ts`, the zone arithmetic uses `Intl.DateTimeFormat` (`packages/core/src/triggers/cronCalendar.ts`), the source is `cronSource.ts`.

### The WHEN

| field | rule |
|---|---|
| `expression` | at most 100 characters, five fields. Lists (`1,15`), ranges (`8-10`), steps (`*/20`, `10-30/5`), names (`JAN`..`DEC`, `SUN`..`SAT`, any case), `7` is Sunday, `?` is `*` in the day fields. A step is between 1 and the size of the field. |
| `timezone` | IANA name, at most 64 characters, default `Europe/Paris`. |
| `catchUp` | `skip` (default), `run_once` or `run_all`: see below. |

The schema refuses, when the trigger is created or edited, an expression that never fires (`0 0 30 2 *`, `0 0 31 4 *`, `0 0 31 4,6,11 *`). `0 0 29 2 *` is valid and fires on leap days. Five fields have a one-minute resolution, so an expression never fires more than once a minute. When both day fields are restricted either may match (`0 0 15 * MON`: the 15th or a Monday), as in Vixie cron; when one is `*` both must match.

The conditions read `event.slot.at` (the slot in UTC, ISO 8601), `event.slot.localDate` (`YYYY-MM-DD`) and `event.slot.localTime` (`HH:mm`), in the zone of the trigger. `event.record.*` and any other prefix are refused. The prompt takes no token from the event. The header holds ids only.

### Slots, dedup and the cursor

- A slot is an instant. The dedup key is `cron:<slot as ISO 8601 UTC>`, so a slot offered twice (a cursor rewound, a restart between the offer and the cursor write) is one fire.
- The cursor of a trigger is a row of `trigger_cursors`, `{ kind: 'cron', through }`: every slot at or before `through` is dealt with. Arming sets it to the present (never behind where it was), so the slots of the time the trigger was disarmed are not offered. A wake offers the slots in `(through, now]` and then moves `through` to the newest of them: the cursor never goes back, and `takeAll` at boot leaves it in place, as it does the cursor of a table.
- A trigger that is armed but has no cursor at boot (armed before the cursors existed) starts from `armed_at`: the slots between then and now are missed slots, judged by `catchUp` and the backlog policy. A trigger armed while the daemon runs starts at the present.
- One timer per armed trigger, set to the next slot and never for more than an hour (`MAX_WAIT_MS`); a wake that finds nothing due sets the next one, after reading the arming again (a fire that trips the breaker leaves no timer). The timer is cancelled when the daemon stops, and when the trigger is edited, disarmed (by a human or by the breaker) or deleted (`TriggerService` calls `onChanged`).
- Scope: the owner scopes what the trigger does, as for the other sources. A slot is about no session, so `close_session` is cancelled `target_not_eligible`, `prompt_manager` reaches the owner when it names no manager, and a named manager outside the lineage of the owner is `target_not_eligible`.
- The activity log gets the ids and the enumerations of every trigger (`trigger.fired`), nothing of the expression or the prompt.

### Time changes (tested on a fake clock in `Europe/Paris`)

- **The clock goes back** (2026-10-25, 03:00 CEST becomes 02:00 CET at 01:00Z): the local hour 02:xx is read twice. An expression with a fixed hour (`30 2 * * *`) fires once, at the first reading (00:30Z). An expression that runs in every hour of the day (`0 * * * *`, `* * * * *`) fires at each real occurrence, so it does not lose a real hour (00:00Z and 01:00Z both fire).
- **The clock jumps** (2026-03-29, 02:00 CET becomes 03:00 CEST at 01:00Z): the local hour 02:xx does not exist. A slot that falls in it fires once, at the first instant after the gap (03:00 local, 01:00Z). All the slots of the missing hour have that same instant, so they are one fire with one dedup key, and an expression that also names 03:00 does not fire twice.

Zones with an offset that is not a whole number of hours work the same way and are tested: `Asia/Kathmandu` (+5:45, `0 9 * * *` is 03:15Z) and `Australia/Lord_Howe` (+10:30 / +11, a 30-minute shift: on 2026-04-05 `45 1 * * *` fires once and `* * * * *` fires at each of the 60 real minutes of the repeated half hour; on 2026-10-04 `15 2 * * *` fires once at 02:30 local, 2026-10-03T15:30Z). `?` is read as `*` before the expression is analysed, so `?/2` and `*/2` are the same in the day fields.

### Catching up after a stop

A wake splits the slots in `(cursor, now]` in two before anything is chosen. A slot found within two minutes of its instant (`ON_TIME_WITHIN_MS`) is **live**: it is always offered, whatever `catchUp` says. An older slot is **missed**: the daemon was stopped or asleep. Two settings judge the missed slots, in this order:

1. `when.catchUp` chooses which missed slots are offered: `skip` none, `run_once` the newest, `run_all` the newest five (`RUN_ALL_CAP`). It never removes a live slot. Missed slots beyond the five are dropped; the cursor moves to the newest slot in all cases. One wake therefore offers five missed slots and the live ones (three at most) however long the stop was: there is no unbounded burst, and the 500-offer budget of the table source is not needed. Example: `* * * * *`, cursor at 10:00Z, woken at 10:05:30Z: 10:04 and 10:05 are live, 10:01 to 10:03 are missed; `skip` offers 10:04 and 10:05, `run_once` offers 10:03, 10:04 and 10:05, `run_all` offers 10:01 to 10:05.
2. The offered slots reach the engine as a backlog, each dated with its slot, and the backlog policy of the trigger judges them like the other sources: `fire_all` fires each, `fire_latest_only` fires the newest and cancels the others `superseded`, `discard_stale` cancels as `stale` what is older than `backlogMaxAgeMinutes` (60 by default).

Examples for an hourly trigger (`0 * * * *`) armed at 10:30 and restarted at 13:30 (missed: 11:00, 12:00, 13:00):

| `catchUp` | `backlogPolicy` | result |
|---|---|---|
| `skip` | any | nothing fires; the cursor moves to 13:00 |
| `run_once` | any | 13:00 fires |
| `run_all` | `fire_all` | 11:00, 12:00 and 13:00 fire, in order |
| `run_all` | `fire_latest_only` | 13:00 fires; 11:00 and 12:00 are cancelled `superseded` |
| `run_all` | `discard_stale`, `backlogMaxAgeMinutes: 90` | 11:00 is cancelled `stale` (150 minutes old); 12:00 (90) and 13:00 fire |

After a 20 hour stop, `run_all` offers the newest five slots only.

## Source `silent_run`

A `silent_run` trigger fires when a child of a manager is `generating` and shows no sign of life for `minutes` (`{ source: 'silent_run', minutes }`, a whole number from 1 to 10080, never 0; the schema refuses anything else). It is a thin layer over what the sleep guard already measures (`SessionService.runtimeProgressOf`): the source is `silentRunSource.ts`.

- A sign of life is strong progress: a hook of the harness (any hook but `Notification`), a transcript that grew, a new turn (`stateSince` moved) or a new process. The pty output is not one: a stuck screen keeps redrawing. A session that is not `generating` (idle, waiting, closed) is never silent in this sense, and one that closes ends its episode. The transcript cursor read for the first time (the file did not exist yet, or the probe was unavailable) and a transcript file that changes identity become the new base of comparison: neither is a sign of life nor ends the silence, but the growth that follows is one. A clock that goes back is not a sign of life either: the silence ends when the clock passes its end again.
- One timer per armed trigger polls every `SILENT_RUN_POLL_MS` (30 s). The timer is cancelled when the trigger is edited, disarmed (by a human or by the breaker), deleted, and when the daemon stops (`TriggerService.onChanged`); a poll sets exactly one next timer.
- The silence is counted from the first look that saw the child with no sign of life. A trigger armed on a child that has been generating for an hour, and a daemon that has just booted, wait the whole `minutes`: there is no catch-up and no backlog, so a boot never makes a burst. Nothing is kept in `trigger_cursors`; a restart resumes every session as a new process, so it is a new episode.
- A poll that comes more than `SLEEP_GAP_MS` (2 minutes) after the previous one is a sleep of the machine: the children not yet offered start their count again at that poll. A silence already offered is not offered again when the machine wakes.
- Dedup key: `silent_run:<session id>:<start of the silence>`. One silence is one episode and fires once however long it lasts; a sign of life ends it, and the next silence is a new episode with a new key.
- Budget: one poll offers at most `MAX_OFFERS_PER_TICK` (20) silences, the others are offered by the next polls (a silence that was offered is not offered again, so it spends no budget twice).
- Scope: the same as `session_state` (`sessionTriggerScope.ts`): children of a manager of the project of the trigger, of the manager the RUN names, in the lineage of the owner when it has one. The scope fails closed: an owner that no longer exists, or is no longer a manager, watches nothing, even when a living intermediate manager still names it as parent.
- Loop guard, by cause: a child is not offered to the trigger whose message (the message id is the fire id) reached it in the hour before its silence began. The activity log gets a `trigger.offer_suppressed` row with the trigger id. Another trigger's message does not suppress it; it is offered one step deeper in the chain (depth 2 at most, `chain_depth`), and that depth is the deepest cause found in the hour before the silence began, so a slow cycle with silences longer than an hour keeps its depth. A trigger that prompts the manager is bounded by the chain depth, the cooldown, `maxFiresPerDay` and the breaker.
- Event: `event.session.id`, `event.session.name`, `event.session.parentId`, `event.session.state` (`generating`), `event.session.minutes`. The prompt may name `event.session.id`, `event.session.name` and `event.session.minutes`; the header holds ids and enumerations only, and the name is not written to the activity log.
- `close_session` never closes a silent child that is still generating: only an idle session is closed (`target_not_eligible`).
- Known limits: the pty is not read, so a child that prints and no more is silent; a child blocked in a long tool call that writes nothing to its transcript is silent too, which is the point. The count is made of polls of 30 seconds, so a fire comes up to 30 seconds after the minutes.

`integration_records` is accepted by the schema and does not fire yet.

## The RUN `run_playbook`

`{ kind: 'run_playbook', playbookId, inputs? }` starts a run of the playbook through the runner of `docs/playbook-runs.md`, with the guarantees of a run started by hand.

- Only an approved playbook runs: the digest as it stands and the sha256 of each pinned script, checked by the runner. Otherwise the fire is `cancelled` with `playbook_unapproved`. The playbook must belong to the project of the trigger; another project, a missing playbook, a playbook this runner cannot run or a secret this device does not hold is `playbook_unavailable`.
- The inputs are those of the RUN, as written when a human armed it. No token and no text of the event reaches them: an event is untrusted, and the digest of arming covers the inputs. An input the playbook does not declare, or of the wrong type, is `playbook_inputs_invalid`.
- The runner keeps its caps. A playbook that already runs, 4 runs at once and 50 runs awaiting a review end the fire `playbook_busy`; nothing is queued and no run is written for a refused fire.
- One effect per fire: the ledger row `(trigger_id, dedup_key)` is unique, so an event offered twice starts one run. The fire is `attempted` while the runner answers, then `completed` with `run_id` set to the run (the fire does not wait for the run to end), or `cancelled` with the reason. A daemon that stops in between leaves the fire `needs_review` (`interrupted`) and never replays it. Chain depth, cooldown, `maxFiresPerDay` and the breaker judge the fire before the effect, as for the other RUN kinds.
- The run is recorded for the actor `admin`: the run table knows no other. The link from a fire to its run is `trigger_fires.run_id`; the run holds no fire id.
- The activity log gets `trigger.fired` with the id of the trigger and the outcome, and the system rows of the run (`playbook.run.started`, `playbook.run.ended`); the inputs and the event are not written to it.

### A change of the playbook disarms the triggers that run it

The digest of arming hashes the id of the playbook and the inputs, not its content. So a write that changes the content of a playbook (an edit of its name, inputs, cells or policy, the restore of a version, the delete) disarms, in the transaction of that write, every armed trigger whose RUN starts it, and bumps their revision: the screen a human read before the change can no longer arm them (`stale_revision`), and arming again takes a new proof of a human gesture, as always. If the disarm fails the write is rolled back. The fires of the trigger are kept; a fire still `accepted` ends `cancelled` as `disarmed`. After the commit the desktop gets the broadcast error `trigger_playbook_changed` and the activity log one `trigger.disarmed_by_playbook` row per trigger, both with ids only. A write that leaves the content alone (the agent lock) disarms nothing. A script file replaced on disk is no write to the playbook: the trigger stays armed and the next fire is cancelled `playbook_unapproved`.
