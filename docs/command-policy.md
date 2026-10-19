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

**Loading.** The file is read at boot only: a change made by hand applies after a restart of the daemon (a save from the settings screen applies at once). An absent file means the delivered policy. A file that is not valid JSON, or has parts the schema refuses, is ignored (the rest still applies) and reported in `issues` of `GET /api/command-policy`: the policy fails open, the daemon still boots.

**Routes.** All behind the admin token; the MCP token of a session gets `401`, so a session cannot read or change its own policy.

| Route | What it does |
|---|---|
| `GET /api/command-policy` | The effective state: `mode`, `unattended`, every rule with its profiles, decision, alternative and whether it is enabled, the valid parts of the saved `override` (or `null`; saving it back is always accepted), and the `issues` that name the ignored parts of the file. |
| `PUT /api/command-policy` | Replaces the whole override. `400 invalid_body` for anything the schema refuses (a deny without an alternative, a role mapped to an unknown profile). `409 config_read_only` when the file cannot be written, `409 config_unreadable` when the file exists but is not valid JSON (it is left untouched for the human to repair). The new state applies to the next hook, with no restart; the write goes through a temporary file and a rename, and is logged. A file the daemon did not write, or that had ignored parts, is first copied to `command-policy.json.bak-<timestamp>`; the answer names the copy in `previousFileKeptAs`. |
| `POST /api/command-policy/evaluate` | `{ command, role?, presence?, harness?, cwd?, toolName?, actor?, model? }` (an unattended child by default) → `{ verdict, mode, profile }`. Nothing is run and nothing is journaled. |
| `GET /api/command-policy/denials?manager=&since=&limit=&cursor=` | The journal, newest first, `{ items, nextCursor? }`. The command excerpt is masked before it is stored: values of `--password`, `--token`, `--secret`, `--api-key` and similar options, `NAME=value` assignments of credentials, `user:pass@host` URLs and `Authorization: Bearer` headers never reach the journal, the API or the `command.denied` event. Entries recorded at the same instant keep a stable order. |

## Command policy: what the manager sees

A manager reads the refusals of its own lineage (its children and every descendant beneath them); another manager's lineage is never visible.

- **`list_denied_commands { limit?, since?, session_id? }`** (MCP, managers only; `not_a_manager` otherwise, `outside_lineage` for a `session_id` of another lineage, `invalid_body` for a `since` that is not a date). Newest first, `limit` 1 to 100 (default 20). Each entry: `kind: "denied_command"`, `id`, `at`, `session_id`, `session_name`, `rule_id`, `decision` (`denied` or `observed`), `excerpt` (already masked by the journal) and `alternative`. `not_shown` counts the matching entries older than the ones returned.
- **Counter.** `ManagerView.deniedCommandCount` is the number of `denied` refusals the manager has not looked at; `deniedCommandTotal` is all of them. Both are in `GET /api/managers/:id` and in `get_argus_status.manager`. Commands the policy only observes count for nothing. Reading the whole list (neither `session_id` nor `since`) moves the manager's read cursor (`denial_read_cursors`, one row per manager) to its newest refusal, so the count falls to 0; a narrowed read leaves it alone.
- **Pulse.** While `deniedCommandCount` is above 0 the pulse text ends with `N command refusals since your last look — call list_denied_commands.` The line is absent at 0, and a queued pulse is rewritten in place, never duplicated, when the number changes.

**Safety net.** A child that stays in `waiting_permission` longer than `permissions.unattendedSilentBlockSeconds` (config.json, default 30, 1 to 3600) raises `permission.silent_blocks` and the daemon queues a message to its manager. It never types into the terminal. The net applies to a child whose dialogs are refused (`askBecomesDeny` true); a session a person watches, a manager, and a child on the approval flow keep `permissions.silentBlockMinutes`.

## Command policy: the findings gate on `gh pr create`

The delivered rule `findings-gate-pr-create` (profile `default`, so every role) matches a `gh pr create` command. The rule only recognises the call; the answer comes from the findings gate, which the Claude hook consults for that rule alone. It reads the branch and the head commit of the session directory (the `cwd` of the hook), takes the ticket from the branch name and opens when the ticket has:

| Step | Needs | Bound to the head commit |
|---|---|---|
| `qe`, `qa` | a `go` or `clean` line, or a logged skip | yes |
| `ponytail` | a line at any commit of the branch, or a logged skip | no |
| `adversarial` | a `go` line (the latest line at the head decides); never skippable | yes |

A new commit therefore closes the gate again. A branch with no ticket is refused with "name the branch with the ticket".

- **Mode.** The gate ships `observe` (`FINDINGS_GATE_ENFORCEMENT`): a closed gate journals the refusal with `outcome: observed` and the command passes. `findingsGate.enforcement: "enforce"` in `config.json` (read at boot) makes it refuse with `findings_required`, the ticket, the missing steps and the endpoint to log a skip, and journal `denied`. It ships `observe` even though `report_step_finding` lets QE, QA and ponytail write their lines. Policy mode `off`, or disabling the rule, switches the gate off.
- **Step reports (`report_step_finding`).** `{ step: qe|qa|ponytail, severity: clean|findings, claims[0..5, 1..300 characters], sha }`; `findings` needs at least one claim. The caller is a session whose `role` is exactly `qe`, `qa` or `ponytail` and whose parent is a manager; each role writes its own step only (a `qe` cannot write `qa`), anything else gets `not_a_manager`, and the `reviewer` writes only through `report_ship_verdict`. The ticket comes from the branch of the caller's worktree, the daemon writes the line (claims masked, one line), and nothing else is written. `qe` and `qa` need `sha` = head (`verdict_stale` otherwise, no line); `ponytail` takes the head or any ancestor of it. A `qe` or `qa` `findings` closes the gate until a later line of that step at the head says `clean` (the latest line wins); a `ponytail` line, `clean` or `findings`, satisfies the ponytail step, which stays informative. A `findings` line is stored with severity `no-go` (the CHECK of migration 033 has no `findings`). **Limit:** the manager is trusted. It picks the role label at `create_session`, and the daemon attests only "a child of the manager, with the role `qe`, reported clean at the head", not that the tests ran. A child of a plain worker (a DEV) cannot take a reserved role: its parent is not a manager. The tool profile of `qe`, `qa` and `ponytail` is not filtered.
- **Ticket pattern.** `findingsGate.ticketPattern` in `config.json` (default `[A-Z][A-Z0-9]+-\d+`, a JavaScript regular expression matched against the branch name; an invalid one refuses the boot). `report_ship_verdict` reads the same pattern.
- **Skips.** `POST /api/review-findings/skips { ticket, step, reason }` (`step` is `qe`, `qa` or `ponytail`; the reason is required) and `GET /api/review-findings/skips?ticket=` live under `/api` behind the admin token. No MCP tool creates a skip, and a session token gets `401`. Each skip is a row of `review_step_skips` with its reason and date, and an info log line.
- **What the analyzer sees.** `gh pr create` is found as a simple command in a sequence (`&&`, `;`), in a pipeline, in `$(...)` and in a subshell. It is also found behind `bash -c "..."`, `env VAR=1`, `xargs` and `eval` (pinned by `findingsGateRule.test.ts`). It is **not** found inside a script file (`bash ./open-pr.sh`), nor when the pull request is created outside OpenFleet (`git push` then the GitHub web page, `gh api`). The gate protects the visible command path of an OpenFleet session, nothing more.
- **Which branch is judged.** Without `--head`, the branch and head commit checked out in the current directory of the command (`cwd` of the hook). With `--head <branch>`, `--head=<branch>`, `-H <branch>` or `-H<branch>` (`owner:<branch>` reads as `<branch>`), the ticket comes from that branch and the head commit is the local branch of that name in the current directory (`git rev-parse refs/heads/<branch>`), so the Lead can create a pull request from its Argus directory when the branch exists in that repository. A head branch that is not a local branch there (another repository, a remote-only branch) is refused as unreadable with `findings_required`, naming the branch and saying to run from its worktree or fetch it; while the gate observes it is only journaled. Each `gh pr create` of a command is judged on its own, and the first closed one decides.
- **`-R` / `--repo`.** The option never changes the judgment, before or after `pr create` (`gh -R owner/repo pr create` is still matched by the rule); the branch is still read in the current directory. A `--head` aimed at a repository other than the current one is therefore judged against the local branch of that name, if any.
- **Known limit: `cd X &&` and `git -C X`.** The gate does not follow a directory change written in the command: `cd <worktree> && gh pr create` is judged on the directory the hook reports, not on `<worktree>`, which may judge the wrong branch or read as unreadable. Use `--head <branch>` or run the command from the worktree.

**Settings screen.** Settings → Command policy shows the mode (three states), the ask switch with what turning it off means, the rule list with a switch per delivered rule, a "Try a command" box (calls `evaluate`), the recent refusals and the number of times the policy engine failed open.
