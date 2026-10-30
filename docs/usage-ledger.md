# Usage ledger module

`packages/core/src/usage/` turns the text of a Claude transcript into per-message usage rows and sums them. It is pure: strings and arrays in, rows and maps out. It reads no file, opens no database and imports nothing from `node:*`.

## What it does

- `parseUsageLines(transcriptText)` reads assistant lines of a JSONL transcript and returns `{ rows, skippedLineCount }`. Each row carries the message id, the timestamp, the model, `input_tokens`, `output_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`.
- A non-empty line that gives no row is skipped and counted: malformed JSON, a line that is not an assistant line, a missing id, model, timestamp or `usage`, or a token count that is negative, fractional or past `Number.MAX_SAFE_INTEGER`. Blank lines are not counted. A missing cache count is read as zero.
- A message id can appear on several lines while a reply streams. The last line of an id wins. Rows come out in order of first appearance of the id. A line replaced by a later one is not counted as skipped.
- Cost: a finite, non-negative `costUSD` on the line gives `costUsd` and `costStatus: 'reported'`. Any other line gets `costUsd: null` and `costStatus: 'unpriced'`. The module holds no price table.
- `buildLedgerRows({ sessionId, biller, rows, billingCodeOf })` stamps rows with the session id, the `biller` (`'subscription'` or `'api'`) and the billing code, which is the id of the root session of the lineage. The caller supplies all three; the module infers none of them.
- `aggregateBySession`, `aggregateByLineage` (by billing code), `aggregateByDayUtc` (key `YYYY-MM-DD`, UTC day of the timestamp) and `aggregateByModel` return a `Map` of totals: message count, the four token sums, `reportedCostUsd` and `unpricedMessageCount`. `reportedCostUsd` adds reported costs only; an unpriced message is counted apart and never adds zero to the cost.

## Real-shape fixture

`packages/core/src/usage/__fixtures__/real-shape-usage.jsonl` is a real-shape fixture, reduced to usage fields, ids synthetic. It comes from one Claude Code transcript and keeps only the usage fields of assistant lines (model, timestamp, the four token counts and the `cache_creation` breakdown, `isSidechain`); message and session ids are replaced by `m1` and `s1`, and every other key is dropped. `parseUsageLines.realShape.test.ts` parses it. The real lines carry no `costUSD`, so a real row reads as `unpriced`.

## Limits

- Sums are plain numbers. A total past `Number.MAX_SAFE_INTEGER` (about 9e15) stays a number but is approximate. A single row can never exceed that limit, since the parser rejects unsafe counts.
- Sidechain lines are kept: they are billed too.
- The parser accepts the shape of the lines only. It does not check that a transcript belongs to a given session.

## What it does not do

The pure part (`parseUsageLines` and the aggregates) has no storage, file reading or price table, and guesses no biller.

## Storage: `usage_daily`

Migration `046_usage_daily.sql` adds two tables. Its down script is `packages/core/src/db/migrations-down/046_usage_daily.down.sql`, kept outside the migrations folder so it is never applied.

- `usage_messages` holds one row per message, keyed by session id and message id. It is the idempotency key.
- `usage_daily` holds the buckets derived from it, keyed by UTC day, model, session, billing code, biller and cost status. A bucket carries the message count, the four token sums and `cost_usd`, the sum of reported costs (`NULL` in an unpriced bucket, which is how unpriced messages are counted apart).

`UsageLedgerService` (`packages/core/src/usage/usageLedgerService.ts`, the only part of the module that touches the database):

- `ingestTranscript({ sessionId, biller, transcriptText, billingCodeOf })` parses the text the caller hands over, upserts the messages and rebuilds the touched buckets in one transaction. Ingesting the same text again changes nothing. A message id seen again replaces its earlier counts, so a message that grew between two ingestions is not added twice. A message whose biller or billing code changes moves to its new bucket.
- `dailyUsage({ fromDayUtc, toDayUtc, sessionId, billingCode, model })` returns the buckets.
- `GET /api/usage/daily?from=&to=&sessionId=&billingCode=&model=` (admin token) answers `{ items }`. `from` and `to` are `YYYY-MM-DD`.

- `GET /api/sessions/:id/usage` (admin token) answers `{ inputTokens, outputTokens }`, the sums of the session over every day and model, or `null` when the ledger holds no row for it. `null` means "no data", never zero. An unknown session answers 404. `GET /api/sessions/:id/tokens` is unrelated: it still answers the session's hook token.
- `GET /api/projects/:id/usage/today` (admin token) answers `{ dayUtc, inputTokens, outputTokens }` for the sessions of the project on the current UTC day, or `null` when none of them has a row today. An unknown project answers 404.

Known limits of the storage:

- **The same message under two sessions is counted twice.** The idempotency key is the session id plus the message id. When a resume or a fork writes the same assistant message (same message id) into the transcripts of two sessions, both are ingested and both are billed in the totals. Nothing deduplicates across sessions.
- **Precision above 2^53.** Token sums are stored and summed as JSON numbers. A single count is rejected past `Number.MAX_SAFE_INTEGER` (2^53 - 1), but a bucket total above it is approximate. The same holds for the costs, which are floating-point sums.
- **Timestamps.** A line is read only when its timestamp is an ISO 8601 date-time with a `Z` or a numeric offset (`+02:00`); the UTC day comes from that instant. A timestamp without a zone, or in another format, is skipped and counted, since its day would depend on the machine's time zone.

There is no ingestion route, no MCP tool, no UI, no automatic reading of any transcript file and no price table.
