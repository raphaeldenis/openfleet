# Scape session MCP aliases

`get_session_card({session_id?})` returns the same compact status as `get_session_status`, with `last_message`: the latest main-chain assistant text from the daemon's trusted transcript, or `null` when unavailable. It strips control/format characters before masking secrets and truncating to 8192 UTF-8 bytes. Its strict Markdown masking includes quoted, backtick-quoted and bare values after credential keys, while ordinary code spans remain readable. The shared diagnostic masker retains its existing policy. The caller may inspect itself, its parent and its direct children.

`message_argus({message, target?, message_id?})` messages the caller's parent manager when target is omitted. An explicit target resolves among the caller's parent and direct children of role manager, by exact session id, then exact case/accent-insensitive name, then unique name prefix. An ambiguous match returns `invalid_body` with authorized candidate ids and names; a missing or inaccessible manager returns `outside_lineage`. A caller without a parent receives `no_parent` when target is omitted.

Targets that normalize to an empty name return `invalid_body`. Ambiguity errors list at most four authorized candidates, ids first, with names capped at 24 characters and an explicit remaining count. Use an exact id or a more specific name for omitted candidates. Secret-looking names may be masked by the shared error formatter. The bounded list fits its unchanged 500-character message cap.

Delivery uses the same agent envelope, 8192-byte message limit, queued/delivered receipt and optional idempotent `message_id` as `send_session_message` and `message_parent`. It never answers a permission gate.

The MCP catalog contains 43 tools, including the project/table aliases and these session aliases.
