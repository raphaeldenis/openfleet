# Usage ledger module

`packages/core/src/usage/` turns the text of a Claude transcript into per-message usage rows and sums them. It is pure: strings and arrays in, rows and maps out. It reads no file, opens no database and imports nothing from `node:*`.

## What it does

- `parseUsageLines(transcriptText)` reads assistant lines of a JSONL transcript and returns `{ rows, skippedLineCount }`. Each row carries the message id, the timestamp, the model, `input_tokens`, `output_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`.
- A non-empty line that gives no row is skipped and counted: malformed JSON, a line that is not an assistant line, a missing id, model, timestamp or `usage`, or a token count that is negative, fractional or past `Number.MAX_SAFE_INTEGER`. Blank lines are not counted. A missing cache count is read as zero.
- A message id can appear on several lines while a reply streams. The last line of an id wins. Rows come out in order of first appearance of the id. A line replaced by a later one is not counted as skipped.
- Cost: a finite, non-negative `costUSD` on the line gives `costUsd` and `costStatus: 'reported'`. Any other line gets `costUsd: null` and `costStatus: 'unpriced'`. The module holds no price table.
- `buildLedgerRows({ sessionId, biller, rows, billingCodeOf })` stamps rows with the session id, the `biller` (`'subscription'` or `'api'`) and the billing code, which is the id of the root session of the lineage. The caller supplies all three; the module infers none of them.
- `aggregateBySession`, `aggregateByLineage` (by billing code), `aggregateByDayUtc` (key `YYYY-MM-DD`, UTC day of the timestamp) and `aggregateByModel` return a `Map` of totals: message count, the four token sums, `reportedCostUsd` and `unpricedMessageCount`. `reportedCostUsd` adds reported costs only; an unpriced message is counted apart and never adds zero to the cost.

## Limits

- Sums are plain numbers. A total past `Number.MAX_SAFE_INTEGER` (about 9e15) stays a number but is approximate. A single row can never exceed that limit, since the parser rejects unsafe counts.
- Sidechain lines are kept: they are billed too.
- The parser accepts the shape of the lines only. It does not check that a transcript belongs to a given session.

## What it does not do

No table, migration, REST route, MCP tool or UI; no file reading; no price table; no guess of the biller.

## Next: PR 2

The `usage_daily` table is a migration and therefore a contract. It is a separate PR, decided by Raphaël. It will store these aggregates; this module stays free of storage.
