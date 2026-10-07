# Scape session MCP aliases

`get_session_card({session_id?})` returns the same compact status as `get_session_status`, with `last_message`: the latest main-chain assistant text from the daemon's trusted transcript, or `null` when unavailable. It masks secrets before truncating to 8192 UTF-8 bytes. The caller may inspect itself, its parent and its direct children.

`message_argus({message, target?, message_id?})` messages the caller's parent manager when target is omitted. An explicit target resolves among the caller's parent and direct children of role manager, by exact session id, then exact case/accent-insensitive name, then unique name prefix. An ambiguous match returns `invalid_body` with authorized candidate ids and names; a missing or inaccessible manager returns `outside_lineage`. A caller without a parent receives `no_parent` when target is omitted.

Delivery uses the same agent envelope, 8192-byte message limit, queued/delivered receipt and optional idempotent `message_id` as `send_session_message` and `message_parent`. It never answers a permission gate.

The MCP catalog contains 43 tools, including the project/table aliases and these session aliases.
