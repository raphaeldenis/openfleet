# Notification triggers

The daemon decides what happened; the desktop decides whether and how to show it. Each trigger is one WebSocket frame `{ type: 'notification.trigger', category, sessionId, ... }` (`NotificationTrigger` in `packages/shared/src/events.ts`). A snapshot never replays a trigger. A trigger carries identifiers, a tool name and a question count only: never tool input or response, transcript, prompt or question text. A client ignores a category it does not know.

| category | extra fields | emitted when |
|---|---|---|
| `agentFinished` | none | a Stop ends the turn and the session is idle |
| `needsInput` | `kind` (`permission` or `input`), `promptKey`, `toolName?` | the session enters a waiting state, once per prompt |
| `toolCompletion` | `toolUseId`, `toolName` | a `PostToolUse` of a top-level agent names its `tool_use_id`, once per id |
| `chatMessage` | `questionKey`, `questionCount` | `update_working_state` adds `questionsForHuman` lines the previous state did not hold |

## toolCompletion

- Silent for a sub-agent's tool run (`agent_id` present), for a hook without `tool_use_id`, and for the tools OpenFleet owns (`update_working_state`, `get_working_state`, the todo tools).
- A replayed hook announces nothing: the last 200 ids of each session are remembered, in memory.
- UNVERIFIED: that a real `PostToolUse` carries `agent_id`. The schema accepts it; the daemon also remembers the `tool_use_id` of every `PreToolUse` that names a sub-agent and ignores the matching `PostToolUse`. Capture a real sub-agent payload to settle it.
- One frame per tool run reaches every client, preferences are applied by the desktop; the desktop coalesces them.

## chatMessage

- `questionCount` counts the distinct new lines. A removed, reordered or unchanged question announces nothing; a line whose text changed counts as new; a question removed and asked again announces again.
- `questionKey` is `<sessionId>@<update time>`, unique per update.
- The question text is never sent; the human reads it in the Inbox.
