# Usage ledger module

`packages/core/src/usage/` turns the text of a Claude transcript into per-message usage rows and sums them. It is pure: strings and arrays in, rows and maps out. It reads no file, opens no database and imports nothing from `node:*`.

## What it does

- `parseUsageLines(transcriptText)` reads assistant lines of a JSONL transcript and returns `{ rows, skippedLineCount }`. Each row carries the message id, the timestamp, the model, `input_tokens`, `output_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`.
- A non-empty line that gives no row is skipped and counted: malformed JSON, a line that is not an assistant line, a missing id, model, timestamp or `usage`, or a token count that is negative, fractional or past `MAX_TOKEN_COUNT` (10^9). Blank lines are not counted. A missing cache count is read as zero.
- Some skipped lines are also rejected and counted in `rejectedLineCount`, because no honest transcript writes them: a line longer than `MAX_LINE_LENGTH` (512 KiB, not parsed), a message id or model that does not match `^[A-Za-z0-9_.:-]{1,128}$`, and a token count above `MAX_TOKEN_COUNT`. `rejectedLineCount` is a subset of `skippedLineCount`.
- A message id can appear on several lines while a reply streams. The last line of an id wins. Rows come out in order of first appearance of the id. A line replaced by a later one is not counted as skipped.
- Cost: a finite, non-negative `costUSD` on the line gives `costUsd` and `costStatus: 'reported'`. Any other line gets `costUsd: null` and `costStatus: 'unpriced'`. The module holds no price table.
- `buildLedgerRows({ sessionId, biller, rows, billingCodeOf })` stamps rows with the session id, the `biller` (`'subscription'` or `'api'`) and the billing code, which is the id of the root session of the lineage. The caller supplies all three; the module infers none of them.
- `aggregateBySession`, `aggregateByLineage` (by billing code), `aggregateByDayUtc` (key `YYYY-MM-DD`, UTC day of the timestamp) and `aggregateByModel` return a `Map` of totals: message count, the four token sums, `reportedCostUsd` and `unpricedMessageCount`. `reportedCostUsd` adds reported costs only; an unpriced message is counted apart and never adds zero to the cost.

## Real-shape fixture

`packages/core/src/usage/__fixtures__/real-shape-usage.jsonl` is a real-shape fixture, reduced to usage fields, ids synthetic. It comes from one Claude Code transcript and keeps only the usage fields of assistant lines (model, timestamp, the four token counts and the `cache_creation` breakdown, `isSidechain`); message and session ids are replaced by `m1` and `s1`, and every other key is dropped. `parseUsageLines.realShape.test.ts` parses it. The real lines carry no `costUSD`, so a real row reads as `unpriced`.

## Limits

- Sums are plain numbers. A total past `Number.MAX_SAFE_INTEGER` (about 9e15) stays a number but is approximate. A single count can never exceed `MAX_TOKEN_COUNT` (10^9), since the parser rejects larger counts; this keeps the SQLite `SUM()` of a bucket far from the 2^63 integer overflow that a few thousand forged counts at 2^53 would reach.
- Sidechain lines are kept: they are billed too.
- The parser accepts the shape of the lines only. It does not check that a transcript belongs to a given session.

## What it does not do

The pure part (`parseUsageLines` and the aggregates) has no storage, file reading or price table, and guesses no biller.

## Storage: `usage_daily`

Migration `046_usage_daily.sql` adds two tables. Its down script is `packages/core/src/db/migrations-down/046_usage_daily.down.sql`, kept outside the migrations folder so it is never applied.

- `usage_messages` holds one row per message, keyed by session id and message id. It is the idempotency key.
- `usage_daily` holds the buckets derived from it, keyed by UTC day, model, session, billing code, biller and cost status. A bucket carries the message count, the four token sums and `cost_usd`, the sum of reported costs (`NULL` in an unpriced bucket, which is how unpriced messages are counted apart).

`UsageLedgerService` (`packages/core/src/usage/usageLedgerService.ts`, the only part of the module that touches the database):

- `ingestTranscript({ sessionId, biller, transcriptText, billingCodeOf, timestampWindow })` parses the text the caller hands over, upserts the messages and rebuilds the touched buckets in one transaction. Ingesting the same text again changes nothing. A message id seen again replaces its earlier counts, so a message that grew between two ingestions is not added twice. A message whose biller or billing code changes moves to its new bucket.
- `dailyUsage({ fromDayUtc, toDayUtc, sessionId, billingCode, model })` returns the buckets.
- `GET /api/usage/daily?from=&to=&sessionId=&billingCode=&model=` (admin token) answers `{ items }`. `from` and `to` are `YYYY-MM-DD`.

- `GET /api/sessions/:id/usage` (admin token) answers `{ inputTokens, outputTokens }`, the sums of the session over every day and model, or `null` when the ledger holds no row for it. `null` means "no data", never zero. An unknown session answers 404. `GET /api/sessions/:id/tokens` is unrelated: it still answers the session's hook token.
- `GET /api/projects/:id/usage/today` (admin token) answers `{ dayUtc, inputTokens, outputTokens }` for the sessions of the project on the current UTC day, or `null` when none of them has a row today. An unknown project answers 404.

Known limits of the storage:

- **The same message under two sessions is counted twice.** The idempotency key is the session id plus the message id. When a resume or a fork writes the same assistant message (same message id) into the transcripts of two sessions, both are ingested and both are billed in the totals. Nothing deduplicates across sessions.
- **Precision above 2^53.** Token sums are stored and summed as JSON numbers. A single count is rejected past `MAX_TOKEN_COUNT` (10^9), but a bucket total above 2^53 - 1 would be approximate. The same holds for the costs, which are floating-point sums.
- **Timestamps.** A line is read only when its timestamp is an ISO 8601 date-time with a `Z` or a numeric offset (`+02:00`); the UTC day comes from that instant. A timestamp without a zone, or in another format, is skipped and counted, since its day would depend on the machine's time zone.

There is no ingestion route, no MCP tool, no price table and no automatic reading of any transcript file, unless the operator enables usageIngestion: then only the token counts are read.

## Ingestion (opt-in)

`usageIngestion` is off by default. The operator turns it on by starting the daemon with `OPENFLEET_USAGE_INGESTION=1` (`DaemonOptions.usageIngestion` in code). Nothing is read otherwise, and the usage routes answer `null` ("n/a" in the desktop) until the ledger holds rows.

When it is on, each `Stop` hook of a session launched by the daemon schedules `TranscriptUsageIngestion.ingestAtStop` after the hook is answered:

- The file is `SessionService.trustedTranscriptFileOf(sessionId)`: the path the session's own hook reported, accepted only if it is an absolute `.jsonl` under the Claude projects directory, symlinks resolved, and named after the session's CLI id. No other path is opened.
- The text goes to `UsageLedgerService.ingestTranscript`, which keeps what `parseUsageLines` extracts: the message id, timestamp, model and the four token counts. The text of a message is never stored, returned or logged, and a line that does not parse is counted, not quoted.
- The biller is `subscription` (the daemon holds no API key). The billing code is the root session of the lineage, found by following `parentId` (a loop stops the walk).
- It fails open: `ingestAtStop` throws an error with a fixed message (never the text of the underlying error); the hook handler logs it after the fixed prefix `usage ingestion failed, recording nothing`, counts it toward the degraded state like the other hooks (`recordHookFailOpen`) at most once a minute per session, and the ingestion changes nothing.

Reading is incremental and bounded:

- Each session has a cursor (`{ path, inode, offset }`) in the memory of the daemon. A `Stop` reads at most 1 MiB (`USAGE_INGESTION_CHUNK_BYTES`) past the cursor, through `readTranscriptChunk`: it opens the file with `O_NOFOLLOW` and `O_NONBLOCK`, refuses anything that is not a regular file, and keeps an incomplete last line for the next `Stop`. A line longer than the chunk is skipped.
- The cursor is lost when the daemon restarts. The transcript is then read again from its start, but under the same cap per `Stop`: the catch-up takes several `Stop` hooks. Re-ingesting is idempotent (upsert on session id and message id), so no message is counted twice. Until the catch-up ends, the totals of a session with a large transcript are partial.
- A file that replaced the transcript (another inode) or became shorter drops the cursor; the next `Stop` reads the new file from its start.
- `Stop` hooks of a session that arrive inside the one-second window of its last ingestion make one trailing ingestion at the end of the window (`PerSessionTrailingThrottle`), and the ingestion is synchronous, so there is never more than one read in flight per session.
- A `Stop` that finds rejected lines logs one warning, `usage ingestion: lines that no honest transcript writes were rejected`, with the session id and the count; it never quotes a line.

Known limits:

- **A session can forge its own usage.** An agent can write assistant lines with any token counts, within the limits above, into its own transcript. The forgery reaches the session, its project, the billing code of the root of its lineage (the manager, whose totals include every descendant) and the global sums of `GET /api/usage/daily`. Nothing is billed from this ledger.
- **No rate limit on `/hooks/<token>`.** A child that posts `Stop` hooks in a loop costs at most one bounded read (1 MiB) per scheduled ingestion; the hook endpoint itself has no rate limit. The 1 MiB bounds the bytes, not the CPU: the CPU of a `Stop` is bounded by the two limits below.
- **CPU of one `Stop`.** An ingestion rebuilds all the buckets it touched with one grouped read of the messages of the session (the only index is the primary key), so its cost is about the number of messages of the session, whatever the number of buckets. The remaining factors are capped: an ingestion touches at most 32 buckets (`maxBucketsPerChunk`; the bucket a stored message leaves counts too, a bucket is a day, model, billing code, biller and cost status), and a session stores at most 100 000 messages (`maxMessagesPerSession`). A message that would exceed either, or that is dated before the session was created minus one day or after now plus one day, is rejected and counted in `rejectedLineCount`. Worst case per `Stop`: one scan of at most 100 000 rows. `usageLedgerService.test.ts` covers two worst cases on a session at its limit (the seeding of 100 000 rows is not timed): 32 new messages in 32 buckets on a session that reaches its maximum, which fails above 1.5 s, and 16 messages rewritten under another model (32 buckets) on a session of 99 984 messages, where the test counts the statements the ingestion prepares and expects exactly one grouped read of the messages for the 32 buckets (the same rewrite took about 0.24 s when each bucket was rebuilt with its own scan, 32 reads). A forged 1 MiB chunk of about 10 000 lines at distinct days and models costs a `Stop` well under a second; without the limits the same chunk took about 4 to 5 s, growing with every later `Stop`.
- **Throughput of the ingestions.** One session runs at most one ingestion per second (`PerSessionTrailingThrottle`): the first `Stop` of a window ingests at once, the `Stop` hooks that follow inside the window collapse into one trailing ingestion at the end of the window, so the last `Stop` of a turn is delayed by up to one second and never lost. A child that posts `Stop` hooks in a loop therefore costs its session at most one ingestion per second. An ingestion is more than one grouped scan: it also reads up to 1 MiB of the transcript and makes up to about 10 000 upserts. The bound is per session, not global: N sessions that post `Stop` hooks in a loop cost N ingestions per second, all on the one event loop of the daemon. The window is measured on a monotonic clock, so a change of the system time neither stretches nor shortens it, and a trailing ingestion never waits more than one window.
- **A session that closes inside its window loses its last `Stop`.** When a session closes, the daemon has already forgotten its transcript path, so nothing is readable for it any more: the timer and the window of the session are dropped with the trailing ingestion, and the tokens of the last turn of that session are not recorded. A daemon shutdown differs: before the sessions are closed, the trailing ingestion of every session still waiting is run once, and a `Stop` that arrives after the shutdown began ingests nothing.
- **A refused message is lost.** A message that the timestamp window, the bucket budget or the session maximum refuses is never stored, and the cursor moves past it anyway. It is read again only after a daemon restart, which reads the transcript from its start.
- **Database growth.** A forged 1 MiB chunk can store about 10 000 `usage_messages` rows (about 100 bytes a line) in one `Stop`, at most 32 buckets of them. Over several `Stop` hooks a session grows up to 100 000 messages and then stores nothing more: the ingestion warns once, `usage ingestion: the session reached its message limit, ingesting nothing more for it`, and stops reading that session until it closes or the daemon restarts. The rows of a session are never deleted by the ingestion.
- **A rewritten transcript can go unseen.** A transcript truncated and then grown back past the cursor offset, with the same inode, is read from the cursor: the ingestion sees neither the truncation nor the lines it replaced. A new inode or a shorter file resets the cursor.
- **Resumed conversations.** Messages dated more than a day before the OpenFleet session was created (a resumed conversation) are rejected and counted, and the warning for rejected lines fires.
- **Ids and models.** A model that is not `^[A-Za-z0-9_.:-]{1,128}$` is rejected, except `<synthetic>`, which Claude Code writes on messages it makes up itself and which is skipped without a warning. A model written as a Bedrock ARN (it contains `/`) would be rejected: not confirmed as a model name Claude Code writes, so the pattern is not widened.
- **Failures.** A failing ingestion logs the fixed message with the session id and the code `usage_ingestion_failed`. A session counts toward the `hook_fail_open` degraded state at most once a minute, so an unreadable transcript posted in a loop does not mark the daemon degraded on its own.
- **Oversized lines.** A line longer than the chunk is skipped to its next line break; its tail is never parsed.

`transcriptUsageIngestion.test.ts` asserts that a canary placed in message text, in a message id, in a model, in a malformed line and in a non-JSON line appears nowhere in the database, the logs or the ledger read the routes serve.
