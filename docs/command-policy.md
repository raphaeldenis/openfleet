# Command policy

## Command policy: permission modes

The command policy answers the `PreToolUse` and `PermissionRequest` hooks of Claude sessions. What a session experiences depends on the permission mode of the CLI.

- **Auto mode (the daemon default).** The CLI emits no `PermissionRequest` at all, for managers and children alike. The policy only acts through `PreToolUse`: a rule that refuses answers a deny with the rule, the reason and an alternative.
- **Manual mode.** The CLI asks for a confirmation on every call its native allowlist does not cover, and emits a `PermissionRequest`.
  - A child (a session with a parent) has no human to answer. It keeps the native allowlist and the allow rules of the policy (such as `allow-read-only-pipelines`, answered with an allow on the `PermissionRequest` too). Everything else is refused immediately, with an alternative, instead of waiting for a dialog nobody reads.
  - A manager follows the approval flow: an approval is created and the session goes to `waiting_permission` until someone decides. The refusal rules of its profile still apply according to the policy mode.
- **A `PreToolUse` allow does not remove the dialog.** In an interactive terminal the CLI still emits the `PermissionRequest` after a `PreToolUse` allow, which is why the policy answers the allow again at that point.

The refusal text of a child tells it to rephrase and, if it really needs the command, to message its manager. A manager never receives that text.
