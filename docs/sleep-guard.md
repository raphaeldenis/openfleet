# Sleep guard

The Node daemon owns sleep protection, including when the Tauri app reuses an existing daemon. On macOS it launches the system executable `/usr/bin/caffeinate` with separate arguments `-i -w <daemonPid>`. There is no shell, display-sleep assertion, user-activity assertion or AC-only `-s` assertion. The helper's `-w` link releases the assertion when the daemon dies, including an unhandled `SIGKILL`. Normal idle and shutdown send SIGTERM to the helper, escalate after one second if necessary, and reap it at shutdown.

The daemon holds one assertion for all sessions with a live launch in `generating`, including managers. `starting`, `idle`, `waiting_input`, `waiting_permission` and `closed` do not count. An attention flag alone does not change the lifecycle or release the assertion. There is no duration cap and no reservation before a prompt starts generating.

`power.preventIdleSleepWhileGenerating` is a boolean in the daemon home's `config.json`. It defaults to true on macOS and false on other platforms, is read at boot and requires a daemon restart to change. Invalid values refuse boot. Disabling it leaves health monitoring active. Other platforms do not spawn caffeinate. No root, Accessibility or notification permission is needed by this implementation; a future sandboxed distribution needs its own packaging validation.

## Possible resume and progress

Every five seconds, a timer measures the interval since its previous callback. An interval over 30 seconds starts a `resume_suspected` cohort of currently generating launches. This may be sleep, a forward clock adjustment or a blocked event loop. It is not a native macOS wake event. A backwards clock adjustment consumes no grace time and starts no new cohort; existing observations continue so recovery remains observable. Another long interruption starts a fresh 120-second window. Sleeping time does not consume this active-time window.

Each launch has its own identity and progress counters. A current non-notification hook or byte growth in the same trusted transcript is strong progress. A changed file identity, historical replacement, truncation, file presence or modification time alone does not prove progress; the cursor is rebased and only later growth counts. The harness port can supply a transcript cursor and process probe without exposing process IDs or paths through the API. Claude uses its current PTY process and the session's already validated transcript; fake harnesses expose controlled probes for testing. There is no Codex harness at this base.

PTY output is weak evidence and does not dismiss a lack of strong progress. A spinner can repaint forever without useful work. Conversely a legitimate long tool or network operation may stay silent for 120 seconds; the resulting flag is a suspicion and never triggers automatic interruption, kill or relaunch.

## Runtime attention contract

Session projections optionally carry:

```json
{
  "runtimeAttention": {
    "launchId": "opaque launch identity",
    "reason": "post_wake_no_progress",
    "detectedAt": "ISO timestamp",
    "wakeSource": "resume_suspected"
  }
}
```

Reasons are `post_wake_no_progress`, `post_wake_health_unknown` and `post_wake_process_exited`. A failed or absent process probe is unknown, not proof of death. An observed exit preserves the existing `closed`, exit code and close reason. Attention about an exit during a resume check remains visible on the closed session until a new launch; other attention clears on strong progress or leaving generating. These observations live in memory and reset on daemon restart.

Authenticated REST `GET /api/sessions` and `GET /api/sessions/:id` return this projection. WS snapshots contain the same sessions, and live changes use `{type: "session.attention", sessionId, runtimeAttention}`; `runtimeAttention: null` clears the field. MCP `get_session_status`, `list_children`, `list_sessions` and the existing `get_argus_status` child views include it when present. Root manager attention is readable through its session status; no parent notification is created for a root.

The pulse scheduler queues a static notification for the current registered live parent manager. Notifications coalesce with queued child-close wakes and deduplicate repeated attention for the same launch. A post-resume exit produces one notice rather than separate close and attention notices. A manager generating or awaiting permission receives a queued message; no direct terminal input answers its gate. Notification text contains session IDs and reason enums, never PTY, transcript text or child-supplied instructions. Managers inspect current status because a queued notice may describe a condition that subsequently recovers.

## Failure and verification

Failure to acquire the power assertion or unexpected helper exit reports the degraded code `power_assertion_unavailable`. The daemon makes at most three acquisition attempts during one continuously active fleet period; becoming idle resets the retry budget. An acquired helper clears the issue. Attention processing and session work continue while power protection is unavailable.

Tests use a fake power API and injected clock to cover assertion lifecycle, retries, timer drift, real versus weak progress, closed-session attention, queue safety and REST/WS/MCP projections. On macOS, run the isolated smoke with a daemon home under `.scratch`: verify `pmset -g assertions`, the last idle release, then kill that fixture daemon with SIGKILL and verify its caffeinate helper exits. Never use the user's daemon home or alter macOS power settings for this check.

Desktop cards, Inbox integration, a live settings toggle and an OS-confirmed native wake source are follow-up work.
