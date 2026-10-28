# Note writes over MCP: revisions, section merge, restore

Every body-changing note write is a compare-and-set on the note's `rev`. A refused write answers `stale_revision` and carries the current rev.

## Mission notes are read-only for agents

A note that any manager links as its mission (`managers.mission_note_id`) refuses every write made by an agent session, manager included: `update_note`, `update_note_section`, `append_to_note`, `move_note`, `delete_note` and `restore_note_version`, file-backed or not. The reply is `unauthorized` with the hint to ask a human to edit the mission note; nothing is changed.

The note is recognised by its link, never by its id: unlinking it makes it writable again, and while two managers link it, it stays protected. Reads (`get_note`, `get_note_version`, `list_note_versions`) and `create_note` are unaffected, and so are a manager's journal table and its other notes. The human keeps every right through the app and the admin REST API.

## `get_note` never exceeds the safe read size

A `get_note` response is at most `NOTE_READ_SAFE_BYTES` (24 KiB of UTF-8 JSON, `packages/core/src/mcp/noteReadPaging.ts`), the size the agent harness shows whole instead of spilling to a file. The optional `max_bytes` lowers that cap (floor 2 KiB) and never raises it; the optional `offset` is a byte offset into the body (snapped down to a character start). Neither adds an error code.

The cap applies in this order:

1. The response (default shape, or `mentions_only`) fits and `offset` is absent or 0: it is returned unchanged. It carries no `complete`, `truncated` or `mentionsIndex` field, and a response without `complete: false` is a whole read.
2. Body and expanded mentions overflow, the body fits: the result holds `bodyMd` whole, no `expandedBody` or `mentionBlocks`, `complete: false`, `nextAction`, and `mentionsIndex`, one `{ id, type, bytes, readWith: "get_note note=<id>" }` per distinct mention written in the body. `bytes` is the size of the mentioned note's body; an unresolved mention has `bytes: 0` and no `readWith`. Mentions of the mentioned notes show up in their own `get_note`.
3. The body alone overflows, or `offset` is above 0: the body is paged. Each page carries `bodyMd` (the slice), `offset`, `bytes`, `totalBytes`, `truncated`, `complete: false` and, while more remains, `nextOffset` and `nextAction: "get_note note=<id> offset=<nextOffset>"`. `nextOffset` is where the slice ends, so contiguous pages cover `[0, totalBytes]` with no byte lost or repeated. `mentionsIndex` is on the page at offset 0. The last page has `truncated: false` and no `nextOffset`; an offset past the end returns an empty last page.

A note is read in full when its response has no `complete: false`, or when contiguous pages from offset 0 to `totalBytes` are read together with every `mentionsIndex` entry.

## `update_note_section`

`expected_rev` is required. When it is the current rev, the section is replaced.

When it is older, the daemon reads the body of revision `expected_rev` from `note_versions` and compares the target section there with the current body:

- the section exists once in both and has the same content: the write is applied to the current revision (one atomic `UPDATE … WHERE rev = ?`, one new version row) and the reply carries `merged: true` with the new rev;
- anything else (content changed, section deleted or created since, the title appears twice, no sections, unknown base revision): `stale_revision`. The message ends with `Conflicting sections: <titles>.` and the error `detail` is `{ currentRev, conflictingSections }`.

Sections are the `##` blocks. Nothing is merged inside a section.

## `restore_note_version`

Pass `expected_rev` (the rev from `get_note`). A rev different from the current one is refused with `stale_revision`; no gap is tolerated.

Grace period: a call without `expected_rev` still succeeds, the reply carries a `warning`, and the daemon logs `restore without expected_rev` with the note id and session id (never the body). The switch is `REQUIRE_EXPECTED_REV_ON_RESTORE` in `packages/core/src/mcp/noteVersionTools.ts`; set to `true`, a call without `expected_rev` is refused as `invalid_body` with a hint to call `get_note`.
