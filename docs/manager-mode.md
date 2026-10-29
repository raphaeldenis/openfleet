# Manager mode

A manager is in one of three modes. The human changes it with `PATCH /api/managers/:id` and `{ "mode": "watching" | "sleeping" | "disabled" }`. A manager never changes its own mode, and there is no MCP tool for it. An unknown value is refused with `invalid_mode`.

| Mode | Timed pulse | Messages and scheduled events | Child auto restart |
| --- | --- | --- | --- |
| `watching` | yes | delivered | yes, if `childAutoRestart` is on |
| `sleeping` | no | all delivered normally, a message wakes the manager | yes, if `childAutoRestart` is on |
| `disabled` | no | held in the queue, replayed in order on reactivation | no |

`pulseEnabled` stays on the API as an alias: it is true only while the mode is `watching`. `PATCH { pulseEnabled: false }` means `sleeping` (a `disabled` manager stays `disabled`), `{ pulseEnabled: true }` means `watching`. A manual pulse of a manager that is not `watching` is refused with `manager_paused`.

## The `[sleep]` message

Switching to `sleeping` queues one `[sleep]` message for the manager, through its normal message queue: it waits for the end of a running turn, and for the reopening of a closed manager. Its id names the switch (`handoff:<sessionId>:<modeChangedAt>`), so a repeated switch, a profile update or a daemon restart never sends a second one. A new switch to `sleeping` after `watching` sends a new one. `sleepHandoffPending` is true until the message is typed; `sleepHandoffDeliveredAt` dates it. `inboundSinceSleepHandoff` counts the messages typed to the manager since then (pulses excluded) and is display only.

## `disabled`

Nothing automated reaches a `disabled` manager: its queue keeps every message (from a child, another manager, a scheduled event, a trigger, and also a message the human sends through the REST API), and the scheduled events stay pending. Only the keys the human types in the manager's own terminal go through. On reactivation the queue is typed in order, due events are delivered, and the children that crashed meanwhile get one restart pass if the manager has `childAutoRestart` on. That pass lives in the memory of the daemon: a daemon restart while the manager is `disabled` forgets it.
