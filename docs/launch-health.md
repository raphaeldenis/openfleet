# Launch health

Two checks keep a spawn from leaving a session that never starts.

- **Binary check.** Before a spawn, the daemon runs `<harness binary> --version`. A failure refuses the spawn with `harness_binary_broken` (retry `later`). The answer is cached for 60 seconds, so a repaired binary is accepted once the cache expires.
- **Launch watchdog.** When `launchOutputTimeoutMs` is set, a new session starts with `readiness: pending`. The first PTY byte moves it to `ready`. When the timeout passes with no PTY byte and no transcript progress, the readiness becomes `failed` with the reason `no_output_at_launch`, the parent session is told, and the launch is retried once on its own. The `readiness` and `readinessReason` fields are returned by the compact session view of the MCP tools.

## Start signal timeout

A new session waits for the harness's start signal (the `SessionStart` hook). The wait is `startSignalTimeoutMs` of the harness, else `firstStartTimeoutMs` of the daemon, else 60 seconds. A harness with no start signal of its own keeps that default and is judged like any other (the `fake` harness included: its tests report `SessionStart` themselves).

When the delay passes with no signal:

- the readiness becomes `failed` with the reason `no_start_signal`, whatever it was before (a PTY byte alone no longer keeps it `ready`);
- the daemon sends `session.failed` (`sessionId`, `reason`, `detail`) on the WebSocket and `session.updated`;
- `detail` is the last 2 KiB of the harness output, without terminal escape sequences and with secrets masked. It is also the `readinessDetail` of the session in REST, WebSocket and the compact MCP view, where a "hook failed" line of the harness shows up;
- the process is stopped and the session is closed with the close reason `resume_timeout`;
- the session no longer counts against the `children_cap` of its manager, from the moment the readiness fails, so the next `create_session` is accepted;
- a `SessionStart` or a PTY byte arriving later changes nothing: the session stays `failed` and closed.

The timer is cancelled when the session closes or reports its start. `readinessDetail` lives in the daemon's memory: a daemon restart forgets it, the `failed` readiness and the close reason stay in the database.

## Known limits

- **Resume and reopen are not checked.** The binary check and the watchdog run on a new spawn only. A session that is resumed or reopened can start with a broken binary or stall without output, and its readiness is not judged.
- **A `pending` readiness survives a daemon restart.** The column is stored, but the watchdog timers live in memory. A session that is `pending` when the daemon stops stays `pending` after the restart: nothing resets it to `failed` or `ready` until it produces output and a new launch watch is armed. Read a `pending` that is older than the timeout as "unknown".
- The binary check covers the harness of the calling session when a manager spawns a child, and the harness of the spec in `create`; a harness without a binary path is not checked.
