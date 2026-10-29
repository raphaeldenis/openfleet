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

The delivered rule `findings-gate-pr-create` (profile `default`, so every role) matches the commands that open a pull or merge request for a child of a manager: `gh pr create`, `glab mr create|new` and a write to `gh api …/pulls` (a POST, explicit or implied by `-f`, `-F` or `--input`; the endpoint may end in `pulls`, `pulls/`, `pulls?query`, `pulls/?query` or `pulls#fragment`; `pulls/12`, `pulls/12/comments`, `pulls-foo` and a GET read such as `pulls?state=open` or `-X GET -f` are never judged as a creation). A repository option before the subcommand (`gh -R o/r`, `glab -R o/r`, `--repo o/r`, `-R=o/r`, `--repo=o/r`) or between the group and the action (`gh pr -R o/r create`, `glab mr -R o/r create`) does not hide the command. The rule only recognises the call; the answer comes from the findings gate, which the Claude hook consults for that rule alone. It reads the branch and the head commit of the session directory (the `cwd` of the hook), takes the ticket from the branch name and opens when the ticket has:

| Step | Needs | Bound to the head commit |
|---|---|---|
| `qe`, `qa` | a `go` or `clean` line, or a logged skip | yes |
| `ponytail` | a line at any commit of the branch, or a logged skip | no |
| `adversarial` | a `go` line (the latest line at the head decides); never skippable | yes |

A new commit therefore closes the gate again. A branch with no ticket is refused with "name the branch with the ticket".

- **Mode.** The gate ships `enforce` (`FINDINGS_GATE_ENFORCEMENT`), whatever the mode of the policy: a closed gate refuses with `findings_required`, the ticket, the missing steps and the endpoint to log a skip, and journals `denied`. `findingsGate.enforcement: "observe"` in `config.json` (read at boot) journals the refusal with `outcome: observed` and lets the command pass. Policy mode `off`, or disabling the rule, switches the gate off.
- **Who is judged.** Only a Claude session whose parent is a manager: the findings pipeline is the one of work driven by a manager. A session without parent, or whose parent is not a manager (direct human work), is not judged: the command passes as before and the journal writes nothing. A judged session is refused on a branch that names no ticket, and on a ticket whose QE, QA, ponytail and adversarial go were not reported by the roles of its manager or skipped by a human. The adversarial go cannot be skipped, so a manager that opens pull requests needs a reviewer who reports `go` with `report_ship_verdict`.
- **Step reports (`report_step_finding`).** `{ step: qe|qa|ponytail, severity: clean|findings, claims[0..5, 1..300 characters], sha }`; `findings` needs at least one claim. The caller is a session whose `role` is exactly `qe`, `qa` or `ponytail` and whose parent is a manager; each role writes its own step only (a `qe` cannot write `qa`), anything else gets `not_a_manager`, and the `reviewer` writes only through `report_ship_verdict`. The ticket comes from the branch of the caller's worktree, the daemon writes the line (claims masked, one line), and nothing else is written. `qe` and `qa` need `sha` = head (`verdict_stale` otherwise, no line); `ponytail` takes the head or any ancestor of it. A `qe` or `qa` `findings` closes the gate until a later line of that step at the head says `clean` (the latest line wins); a `ponytail` line, `clean` or `findings`, satisfies the ponytail step, which stays informative. A `findings` line is stored with severity `no-go` (the CHECK of migration 033 has no `findings`). **Limit:** the manager is trusted. It picks the role label at `create_session`, and the daemon attests only "a child of the manager, with the role `qe`, reported clean at the head", not that the tests ran. A child of a plain worker (a DEV) cannot take a reserved role: its parent is not a manager. The tool profile of `qe`, `qa` and `ponytail` is not filtered.
- **Ticket pattern.** `findingsGate.ticketPattern` in `config.json` (default `[A-Z][A-Z0-9]+-\d+`, a JavaScript regular expression matched against the branch name; an invalid one refuses the boot). `report_ship_verdict` reads the same pattern.
- **Skips.** `POST /api/review-findings/skips { ticket, step, reason }` (`step` is `qe`, `qa` or `ponytail`; the reason is required) and `GET /api/review-findings/skips?ticket=` live under `/api` behind the admin token. No MCP tool creates a skip, and a session token gets `401`. Each skip is a row of `review_step_skips` with its reason and date, and an info log line.
- **What the analyzer sees.** `gh pr create` is found as a simple command in a sequence (`&&`, `;`), in a pipeline, in `$(...)` and in a subshell. It is also found behind `bash -c "..."`, `env VAR=1`, `xargs` and `eval` (pinned by `findingsGateRule.test.ts`). It is **not** found inside a script file (`bash ./open-pr.sh`), nor when the pull request is created outside OpenFleet (`git push` then the GitHub web page). The gate protects the visible command path of an OpenFleet session, nothing more.
- **Known bypasses, not covered.** `gh api graphql` with a `createPullRequest` mutation, `curl -X POST` against the forge API, `glab api`, `git push -o merge_request.create`, `hub`, `sudo` in front of the command and a `gh alias` that expands to a creation are not judged. An upper-case endpoint (`PULLS`) is not recognised either; it is left out on purpose, since GitHub expects `pulls` in lower case.
- **The manager itself is outside the gate.** Only sessions run by a manager are judged; the manager that opens pull requests is not (decision of Raphaël).
- **Which branch is judged.** Without `--head`, the branch and head commit checked out in the current directory of the command (`cwd` of the hook). With `--head <branch>`, `--head=<branch>`, `-H <branch>` or `-H<branch>` (`owner:<branch>` reads as `<branch>`), the ticket comes from that branch and the head commit is the local branch of that name in the current directory (`git rev-parse refs/heads/<branch>`), so the Lead can create a pull request from its Argus directory when the branch exists in that repository. A head branch that is not a local branch there (another repository, a remote-only branch) is refused as unreadable with `findings_required`, naming the branch and saying to run from its worktree or fetch it; when the gate observes it is only journaled. Each `gh pr create` of a command is judged on its own, and the first closed one decides.
- **`-R` / `--repo`.** The option never changes the judgment, before the group, between the group and the action, or after `create` (`gh -R owner/repo pr create`, `gh pr -R owner/repo create` and `glab mr -R owner/repo create` are still matched by the rule; other commands such as `gh issue` are unchanged); the branch is still read in the current directory. A `--head` aimed at a repository other than the current one is therefore judged against the local branch of that name, if any.
- **Known limit: `cd X &&` and `git -C X`.** The gate does not follow a directory change written in the command: `cd <worktree> && gh pr create` is judged on the directory the hook reports, not on `<worktree>`, which may judge the wrong branch or read as unreadable. Use `--head <branch>` or run the command from the worktree.

## Command policy: the guard on the generic `SendMessage`

The `SendMessage` tool of the Claude harness reaches only the sub-agents of the session that calls it. A manager that passes a session uuid or a manager name gets "No agent named ... is reachable" and may wrongly conclude that the target is down. The delivered rule `no-generic-send-message-to-fleet-session` (profile `default`, so every role, attended or not, session or sub-agent) refuses that call with a pointer to the fleet tools: `message_argus` for a manager, `send_session_message` for any other session.

- **What is refused.** A `SendMessage` whose `to` is a session uuid, a prefix of one (8 hex digits, then optional dash-separated hex groups), or the name of a manager session (case-insensitive; the daemon looks the name up among its manager sessions when it builds the policy request).
- **What passes.** Any other `to`: the name of a sub-agent of the caller (`researcher`, `test-runner`), `*`, or a call without `to`. The policy cannot see the sub-agents of the caller, so it refuses only what is certainly a fleet session.
- **Known limit.** A sub-agent given the same name as a manager session is refused; rename the sub-agent. A sub-agent whose name is exactly 8 hexadecimal characters (`deadbeef`) is refused too, because it reads as a session uuid prefix. A non-manager session addressed by name is not recognised (only managers and uuids are), so that call still gets the harness error.
- **Predicate.** `recipientIsFleetSession: true` in a rule's `when`; it reads `recipient` (the `to` of the call) and `recipientNamesManager` of the policy request, and holds for no other tool.
- **Mode.** Follows the policy mode: `observe` journals and lets the call pass, `off` or disabling the rule switches it off. The journal records the tool `SendMessage` with the recipient as the command excerpt.
## Command policy: file writes go through the edit tools

The delivered rule `no-shell-file-writes` (profile `default`, so every role; `Bash` only; unattended sessions only) refuses a command that writes file content through the shell and answers with a guidance: create or change the file with the `Write` tool (a whole file) or the `Edit` tool (a replacement), `NotebookEdit` for a notebook. The point is to keep a child out of the permission dialog nobody reads. Under `observe` the refusal is journaled and the command passes.

The rule uses the predicate `writesFilesOutside`, true when one simple command writes outside the roots `{scratch}`, `{worktree}/.scratch` and `{toolResults}` (a relative target resolves against the `cwd` of the command, `..` is folded, `$VAR` and `~` targets cannot be resolved and count as outside).

| Form | Judged as a write |
|---|---|
| Redirect to a file: `>`, `>>`, `>|`, `&>`, `&>>`, `<>`, `>& file`, with or without a descriptor (`2> f`) | yes, heredocs included (`cat > f <<'EOF'`, `cat <<'EOF' > f`) |
| A line that only redirects: `> f`, `{ …; } > f`, `(…) > f`, `done > f`, `exec > f` | yes |
| `tee <file>` (`tee` with no file is a pass-through; behind `xargs` it names files on stdin and counts) | yes |
| `sed -i`, `sed -i.bak`, `sed --in-place` with a file outside the roots; `perl -i` / `-pi` | yes |
| `dd of=<file>` | yes |
| `python`, `node`, `deno`, `bun`, `ruby`, `perl`, `php` with inline code (`-c`, `-e`, `-p`, `--eval`, `eval`), a here-document or a here-string that opens a file for writing (`open(…, 'w'\|'a'\|'x'\|'r+')`, `write_text`, `writeFile*`, `appendFile*`, `createWriteStream`, `File.write`, `file_put_contents`, a perl `open` with `>`), shells out to a redirect, `tee` or `sed -i`, or decodes a payload and runs it (`b64decode` + `exec`) | yes |

Never judged: `> /dev/null`, `&>/dev/null`, `2>&1`, `>&2`, `/dev/stdout`, `/dev/stderr`, `/dev/tty`, `/dev/fd/N`, input redirects, a redirect, `tee` or `sed -i` whose target is inside `.scratch/` of the worktree (or a `{scratch}` / `{toolResults}` root), reads (`cat`, `grep`, `sed` without `-i`), `sed` without a file, an interpreter that only reads or prints, and an interpreter that runs a script file (`python3 scripts/x.py`).

The analyzer sees through `bash -c`, `sh -c`, `eval`, `env`, `command`, `xargs`, `find -exec`, `$(…)`, subshells and shell scripts read from a heredoc, as for the findings gate. **Known limits, not covered:** a script file that writes (`bash ./gen.sh`, `python3 gen.py`), an interpreter that reads its program from a pipe (`echo "…" | python3`), code assembled at run time from pieces the rule cannot read, and programs that write by other means (`cp`, `mv`, `install`, `curl -o`, `wget -O`, `git checkout`, `touch`). An interpreter whose code writes into `.scratch/` is still steered to the tools, since the code is not resolved to a path.

The same rule is stated in section §9 of the manager base, which tells managers to say it in every child brief. The manager base template moves to version 3 with this rule (a change to the template contract): a manager that runs on version 2 does not tell its children about it until its base is updated.

**Settings screen.** Settings → Command policy shows the mode (three states), the ask switch with what turning it off means, the rule list with a switch per delivered rule, a "Try a command" box (calls `evaluate`), the recent refusals and the number of times the policy engine failed open.
