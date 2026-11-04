# Playbook runs

**In brief.** A playbook of script cells runs only after a human approved its digest. The runner starts each script itself, with no shell, journals every step before it starts, and masks the value of every secret before anything is stored or answered. A daemon killed in the middle of a step marks the run `needs_review` at the next boot and never starts the step again. This page describes the first wave of the runner (PBK-P3a); `http`, `readFromStore`, `writeToStore` and `tool` cells, `run_playbook` and the other kinds come later.

## Who can do what

| Action | Human (admin REST) | Agent (MCP) |
|---|---|---|
| Read the approval digest | `GET /api/playbooks/:id/approval` | no tool |
| Approve | `POST /api/playbooks/:id/approve` `{ digest }` | no tool |
| Run | `POST /api/playbooks/:id/run` `{ inputs }` | no tool until PBK-P4 |
| Read a run | `GET /api/playbook-runs/:id`, `GET /api/playbook-runs?playbookId=` | no tool until PBK-P4 |

The admin token is not a proof of a human gesture: any process of the user can read `admin.token`. The approval stops an agent that has only its MCP token, as `agent_locked` does; the desktop app is where a human reads the digest before confirming it.

## The approval

The digest is the sha256 of the canonical JSON of the name, the inputs, the cells, the policy and the sha256 of every script file the cells name. `GET .../approval` answers the digest and the scripts it pins; `POST .../approve` takes that digest back and is refused with `approval_digest_mismatch` when the playbook is no longer the one that was read. Any edit of the playbook clears the approval, so an agent that edits an approved playbook leaves it inert until a human approves again.

A run checks the approval twice: at launch (the digest of the content as stored, the sha256 of each pinned file) and right before each step (the file that is about to start). A file that changed, is gone or is unsafe to start fails with `script_changed`; content that no longer matches the digest is `playbook_unapproved`.

## Scripts

A script cell names a `program`: a literal path, relative to a script root or absolute inside one. A token in it is refused: an approval cannot pin it. The real path, after symlinks, stays inside the root; the file belongs to the daemon's user, is not writable by group or others and is executable. The roots are `playbooks.scriptRoots` of `config.json` (absolute paths, at most 16); with none, no script runs.

The script starts with the basic environment of the daemon (`PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `TMPDIR`, `SHELL`, `LC_*`) plus the `env` of the cell, in its own process group, in the folder of the file. At the timeout of the cell (`timeoutSeconds`, 10 minutes by default) and at the shutdown of the daemon the group is killed.

Known limit: the hash is read, then the file is started; a file that changes in between is not seen. The owner and permission checks narrow that window to the user's own processes.

## The journal

A run is written `running` before its first step. A step is written `running` before its script starts, then `succeeded`, `failed` or `needs_review` with its masked output. A step that does not succeed ends the run `failed` with the code of the step (`script_failed`, `script_timeout`, `script_changed`, `untrusted_reference`, `unresolved_reference`, `step_limit_exceeded` ...).

At boot every run and step left `running` is marked `needs_review` with the code `interrupted`: a step that was running may have had its effect, so nothing starts it again. A script that outlives a daemon killed with `kill -9` is not stopped by the next boot; the step is only marked. A new run of the playbook is allowed.

## Masking

The values of the secrets the playbook references are resolved when the run starts (`secret_not_connected_on_this_device` refuses the run, and nothing is written, when this device holds none). The output of a step goes through the shape-based layer of `redact.ts`, then through the value-based masker: the plain, URL-encoded, base64 and JSON-escaped forms of each value become `[secret:NAME]`. The inputs of the run are masked the same way before they are stored. A script that hashes, splits or re-encodes the value defeats the masker; the approved script is the control.

## Limits

1000 step executions per run (a flow stored outside the save path with an undocumented loop stops there with `step_limit_exceeded`), 4 runs at once and one per playbook (`playbook_run_busy`), 256 KiB of output per step (the rest is dropped and the output ends with `[truncated]`), `maxRunsToKeep` finished runs per playbook.

A token is checked in its place again at run time: the output of a step never reaches the arguments or the environment of a script, whatever the way the flow was stored.
