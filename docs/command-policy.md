# Command policy

## Command policy: permission modes

The command policy answers the `PreToolUse` and `PermissionRequest` hooks of Claude sessions. What a session experiences depends on the permission mode of the CLI.

- **Auto mode (the daemon default).** The CLI emits no `PermissionRequest` at all, for managers and children alike. The policy only acts through `PreToolUse`: a rule that refuses answers a deny with the rule, the reason and an alternative.
- **Manual mode.** The CLI asks for a confirmation on every call its native allowlist does not cover, and emits a `PermissionRequest`.
  - A child (a session with a parent) has no human to answer. It keeps the native allowlist and the allow rules of the policy (such as `allow-read-only-pipelines`, answered with an allow on the `PermissionRequest` too). Everything else is refused immediately, with an alternative, instead of waiting for a dialog nobody reads.
  - A manager follows the approval flow: an approval is created and the session goes to `waiting_permission` until someone decides. The refusal rules of its profile still apply according to the policy mode.
- **A `PreToolUse` allow does not remove the dialog.** In an interactive terminal the CLI still emits the `PermissionRequest` after a `PreToolUse` allow, which is why the policy answers the allow again at that point.

The refusal text of a child tells it to rephrase and, if it really needs the command, to message its manager. A manager never receives that text.

## Command policy: configuration

The policy the daemon enforces is the delivered document plus an override the human saves in `<OPENFLEET_HOME>/command-policy.json` (mode 0600). Without the file the delivered policy applies, in `observe` mode with `unattended.askBecomesDeny` true.

```json
{
  "version": 1,
  "mode": "enforce",
  "unattended": { "askBecomesDeny": true },
  "disabledRules": ["no-forced-git-clean"],
  "rules": [],
  "profiles": {},
  "roleToProfile": {}
}
```

Every key but `version` is optional. `mode` is `enforce`, `observe` (journals what a rule would refuse, refuses nothing) or `off` (the rules of the profiles are switched off). A rule added in `rules` follows the shared schema: a `deny` without an `alternative` is refused.

**Two independent switches.** `mode: off` switches the profile rules off but does **not** touch the conversion of a permission dialog into a refusal for child sessions. Only `unattended.askBecomesDeny: false` gives the dialogs back to the approval flow. That is the rollback of the invisible-prompt incident: a child may then wait on a prompt nobody sees, and the 30-second safety net below alerts its manager. A session reports `policyEnforcement: "none"` only when both switches are off.

**Loading.** The file is read at boot. An absent file means the delivered policy. A file that is not valid JSON, or has parts the schema refuses, is ignored (the rest still applies) and reported in `issues` of `GET /api/command-policy`: the policy fails open, the daemon still boots.

**Routes.** All behind the admin token; the MCP token of a session gets `401`, so a session cannot read or change its own policy.

| Route | What it does |
|---|---|
| `GET /api/command-policy` | The effective state: `mode`, `unattended`, every rule with its profiles, decision, alternative and whether it is enabled, the saved `override` (or `null`), and the `issues` of the file. |
| `PUT /api/command-policy` | Replaces the whole override. `400 invalid_body` for anything the schema refuses (a deny without an alternative, a role mapped to an unknown profile). `409 config_read_only` when the file cannot be written, `409 config_unreadable` when the file exists but is not valid JSON (it is left untouched for the human to repair). The new state applies to the next hook, with no restart; the write goes through a temporary file and a rename, and is logged. |
| `POST /api/command-policy/evaluate` | `{ command, role?, presence?, harness?, cwd?, toolName?, actor?, model? }` (an unattended child by default) → `{ verdict, mode, profile }`. Nothing is run and nothing is journaled. |
| `GET /api/command-policy/denials?manager=&since=&limit=&cursor=` | The journal, newest first, `{ items, nextCursor? }`. Entries recorded at the same instant keep a stable order. |

**Safety net.** A child that stays in `waiting_permission` longer than `permissions.unattendedSilentBlockSeconds` (config.json, default 30, 1 to 3600) raises `permission.silent_blocks` and the daemon queues a message to its manager. It never types into the terminal. The net applies to a child whose dialogs are refused (`askBecomesDeny` true); a session a person watches, a manager, and a child on the approval flow keep `permissions.silentBlockMinutes`.

**Settings screen.** Settings → Command policy shows the mode (three states), the ask switch with what turning it off means, the rule list with a switch per delivered rule, a "Try a command" box (calls `evaluate`), the recent refusals and the number of times the policy engine failed open.
