# Note writes over MCP: revisions, section merge, restore

Every body-changing note write is a compare-and-set on the note's `rev`. A refused write answers `stale_revision` and carries the current rev.

## Mission notes are read-only for agents

A note that any manager links as its mission (`managers.mission_note_id`) refuses every write made by an agent session, manager included: `update_note`, `update_note_section`, `append_to_note`, `move_note`, `delete_note` and `restore_note_version`, file-backed or not. The reply is `unauthorized` with the hint to ask a human to edit the mission note; nothing is changed.

The note is recognised by its link, never by its id: unlinking it makes it writable again, and while two managers link it, it stays protected. Reads (`get_note`, `get_note_version`, `list_note_versions`) and `create_note` are unaffected, and so are a manager's journal table and its other notes. The human keeps every right through the app and the admin REST API.

## `update_note_section`

`expected_rev` is required. When it is the current rev, the section is replaced.

When it is older, the daemon reads the body of revision `expected_rev` from `note_versions` and compares the target section there with the current body:

- the section exists once in both and has the same content: the write is applied to the current revision (one atomic `UPDATE … WHERE rev = ?`, one new version row) and the reply carries `merged: true` with the new rev;
- anything else (content changed, section deleted or created since, the title appears twice, no sections, unknown base revision): `stale_revision`. The message ends with `Conflicting sections: <titles>.` and the error `detail` is `{ currentRev, conflictingSections }`.

Sections are the `##` blocks. Nothing is merged inside a section.

## `restore_note_version`

Pass `expected_rev` (the rev from `get_note`). A rev different from the current one is refused with `stale_revision`; no gap is tolerated.

Grace period: a call without `expected_rev` still succeeds, the reply carries a `warning`, and the daemon logs `restore without expected_rev` with the note id and session id (never the body). The switch is `REQUIRE_EXPECTED_REV_ON_RESTORE` in `packages/core/src/mcp/noteVersionTools.ts`; set to `true`, a call without `expected_rev` is refused as `invalid_body` with a hint to call `get_note`.
