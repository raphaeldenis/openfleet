# Playbook runs

**In brief.** A playbook of script cells runs only after a human approved its digest. The runner starts each script itself, with no shell, journals every step before it starts, and masks the value of every secret before anything is stored or answered. A daemon killed in the middle of a step marks the run `needs_review` at the next boot and never starts the step again. This page describes the runner of script cells (PBK-P3a), `http` cells (PBK-P3b-http) and `readFromStore` and `writeToStore` cells (PBK-P3B-STORE-TOOL); `tool` cells (PBK-P3B-TOOL) and the other kinds come later. A trigger starts a run with the RUN `run_playbook` (see `docs/triggers.md`).

## Who can do what

| Action | Human (admin REST) | Agent (MCP) |
|---|---|---|
| Read the approval digest | `GET /api/playbooks/:id/approval` | no tool |
| Approve | `POST /api/playbooks/:id/approve` `{ digest }` | no tool |
| Run | `POST /api/playbooks/:id/run` `{ inputs }` | no tool until PBK-P4 |
| Read a run | `GET /api/playbook-runs/:id`, `GET /api/playbook-runs?playbookId=` | no tool until PBK-P4 |

The admin token is not a proof of a human gesture, by design: whoever holds it, an agent that can read `admin.token` included, can read the digest, approve and run a playbook it wrote itself, and the daemon cannot tell it from a human (there is no desktop nonce on these routes). The approval separates the admin from the MCP token and nothing more: it stops an agent that has only its MCP token, as `agent_locked` does. Treat the admin token as the authority to run the scripts under the script roots; the desktop app is where a human is expected to read the digest before confirming it.

## The approval

The digest is the sha256 of the canonical JSON of the name, the inputs, the cells, the policy and the sha256 of every script file the cells name. `GET .../approval` answers the digest and the scripts it pins; `POST .../approve` takes that digest back and is refused with `approval_digest_mismatch` when the playbook is no longer the one that was read. Any edit of the playbook clears the approval, so an agent that edits an approved playbook leaves it inert until a human approves again.

A run checks the approval twice: at launch (the digest of the content as stored, the sha256 of each pinned file) and right before each step (the file that is about to start). A file that changed, is gone or is unsafe to start fails with `script_changed`; content that no longer matches the digest is `playbook_unapproved`.

## Scripts

A script cell names a `program`: a literal path, relative to a script root or absolute inside one. A token in it is refused: an approval cannot pin it. The real path, after symlinks, stays inside the root; the file belongs to the daemon's user, is not writable by group or others and is executable. The roots are `playbooks.scriptRoots` of `config.json` (absolute paths, at most 16); with none, no script runs.

The script starts with the basic environment of the daemon (`PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `TMPDIR`, `SHELL`, `LC_*`) plus the `env` of the cell, in its own process group, in the folder of the file. The group is killed when the step ends, whatever the way it ends: after an exit (0 or not) every process the script left running dies with it, so a script cannot leave background work behind; at the timeout of the cell (`timeoutSeconds`, 10 minutes by default) and at the shutdown of the daemon the group gets SIGTERM, then SIGKILL after a grace period of 2 seconds. The run slot is released after that kill, and every timer of the step is cancelled when the step is answered: no signal reaches the group afterwards, so a process group id reused by another program is never signalled. A process that leaves the group on its own (`setsid`) is out of reach. A script whose `spawn` fails, for instance because a variable holds a NUL, fails the step with `script_spawn_failed`; the error of the system, which can carry the value of a variable, is neither logged nor stored.

Known limit: the hash is read, then the file is started; a file that changes in between is not seen. The owner and permission checks narrow that window to the user's own processes.

## The journal

A run is written `running` before its first step. A step is written `running` before its script starts, then `succeeded`, `failed` or `needs_review` with its masked output. A step that does not succeed ends the run `failed` with the code of the step (`script_failed`, `script_timeout`, `script_changed`, `untrusted_reference`, `unresolved_reference`, `step_limit_exceeded` ...).

At boot every run and step left `running` is marked `needs_review` with the code `interrupted`: a step that was running may have had its effect, so nothing starts it again. A script that outlives a daemon killed with `kill -9` is not stopped by the next boot; the step is only marked. A new run of the playbook is allowed.

## Masking

The values of the secrets the playbook references are resolved when the run starts (`secret_not_connected_on_this_device` refuses the run, and nothing is written, when this device holds none). The output of a step goes through the shape-based layer of `redact.ts`, then through the value-based masker: the plain, URL-encoded, base64 and JSON-escaped forms of each value become `[secret:NAME]`. The inputs of the run are masked the same way before they are stored. A script that hashes, splits or re-encodes the value defeats the masker; the approved script is the control. The cap of the output never cuts a secret: the step keeps the cap plus the length of the longest spelling of the secrets of the run, and the cut moves back before a secret that crosses it, on stdout and on stderr alike. An unexpected error of a step is masked with the values of the run before it is logged.

## http cells

An `http` cell calls a host the human approved: `allowedHosts` in the policy lists exact lowercase host names (IDN in punycode) or IPv4 literals, with no wildcard, port or userinfo. The list is empty by default, so no host is reachable, and it is part of the approval digest: changing it clears the approval.

The name is resolved once. A name that resolves to a loopback, private, link-local, shared or multicast address, or one of whose answers does, is refused with `http_address_blocked`; the connection then goes to the address that was checked, so a DNS answer that changes in between has no effect. A literal IP written in `allowedHosts` is the human's choice and is not range-checked. The scheme is `https`; `http` is accepted only for a loopback address. A redirect is never followed (`http_redirect_refused`). A response outside 2xx fails the step with `http_status_failed` and keeps its masked body. The step answers `status` and `output` (the body, capped like a script's output and treated the same way: shape-based layer, value masker, control characters). Response headers are not kept and no cookie is sent or stored.

A secret may stand in the headers and the authentication only; the url and the body refuse it. The output of an earlier step is refused in the authority of the url, the headers and the authentication, and accepted in the path, the query and the body, where it cannot steer the request elsewhere. Each token is checked in its place again at run time. Headers with a line break, headers the client sets itself (`Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, ...) and resolved headers over 16 Ki characters fail the step before anything is sent.

A step found running at boot is `needs_review`, like any step: the request may have reached the server, so it is never sent again.

Known limits: a server that echoes a secret in a form the daemon cannot recognise (hashed, split, or combined with other text before base64) defeats the masker, as for scripts. A literal IP in `allowedHosts` can point at a private address on purpose.

## Store cells

A `readFromStore` or `writeToStore` cell works on a table of the project of the playbook, and on no other: the data store service checks the owner of the table on every call, with the project of the playbook, so a table of another project and a table that does not exist both fail the step with `store_not_in_project`, and the answer says nothing more. The table (`storeID`) and the columns (`columns`, `whereColumnID`, `sortColumnID`, `naturalKeyColumnID`, the keys of `rowMappings`) are ids. They may hold literals and `{{inputs.x}}` but never the output of a step: the save refuses it with `untrusted_reference`, and the runner checks again before it touches the table. A value (`whereValue`, the values of `rowMappings`) accepts any token except a secret.

A read filters on one column (`whereColumnID` and `whereValue` go together, else `store_filter_incomplete`; the comparison is an equality), sorts on one, and answers `rowCount` and `output`, the rows as JSON (`[{ id, data }]`, only the columns asked for). It answers 100 rows when the cell sets no `limit` and at most 1000 whatever the limit; an answer over 256 Kio of UTF-8 bytes (not characters: a text of multi-byte characters weighs its bytes) fails the step with `store_read_too_large` and keeps no row (it is never cut). The limit and the columns are applied by the read itself, not after it: the rows stream out of the database one at a time and only the cells asked for are built; without a sort the scan stops at the row that fills the `limit` (a read of `limit: 1, columns: []` on a table of 5000 rows reads one row), with a sort the matching rows are held to be sorted. In both cases the rows kept are counted in bytes as they arrive and the read stops, with `store_read_too_large`, at the row that crosses 256 Kio, so a table of large cells is never loaded whole. The rows go through the same treatment as a script's output: the shape-based layer, the value masker, the control characters.

A write inserts one row, or, when the cell names a `naturalKeyColumnID`, upserts on the natural key the table holds. That column must be exactly the natural key the table holds when the step runs: an id that is no column, a column of another table, a column that is not the key, the former key of a table that has changed it, and any column on a table that has no natural key all fail the step with `store_natural_key_mismatch` before anything is written (a table with no key takes inserts only, with no `naturalKeyColumnID`). It answers `outcome` (`inserted` or `updated`) and `rowId`, never the cells. Every value passes through the value masker before the write, so the value of a secret never reaches a table. The history of the table names the author `playbook run <run id>`, with the actor kind `trigger` (the automation kind the history accepts without a migration).

Values are written as text: a number, json or select column takes a string that is valid for it, and a text that is not fails the step with `store_value_rejected`. The failure of a store step is a code of the journal and nothing else: `store_column_unknown`, `store_natural_key_mismatch`, `store_value_rejected`, `store_row_cap_reached` (the table is at its 10,000 rows), `store_read_failed`, `store_write_failed`. No row, no value and no error text goes in the activity log, in the journal of the failure or in the logs (the log line names the type of the error only). The activity log keeps the ids of the run, as for any run.

A step found running at boot is `needs_review`, like any step. A write is never replayed: the row may be written. A read could be replayed without harm, but the journal says what ran, so it is marked and not started again either. A write that is committed when the daemon stops leaves its step `running`; at boot the step becomes `needs_review` and the write is not made again (the row is in the table once).

Known limits:
- The secret mask is per run. It knows the secrets the playbook of the run references, nothing else. A secret value that is already in clear in a table, and that the current run does not reference (the secret of another playbook or run, or an old value after a rotation), is not masked when a read returns it: it can reach the journal of the step and the REST view of the run. The sentence "the value of a secret never reaches a table" holds for the values the run knows, not for a table that someone else filled.
- The loop guard of the triggers (`tableSource`) sees only the writes of a session acting as an agent. The write of a run is seen by it only if the run was started by a trigger, through the active run of that trigger (PBK-TR6, PR #434); otherwise it carries no chain depth. This change must be merged after #434.
- With a sort, the matching rows are held in memory to be sorted, up to 256 Kio of cells; a larger set fails with `store_read_too_large` even if `limit` is small.
- Rows are read with the cells they hold, an empty cell is left out of the answer (an absent cell and a cell set to `null` read the same).

## The tool cell

A `tool` cell is refused with `playbook_not_runnable` before anything is written. A run has no session, no role and no actor to give the tool, and the handlers of the MCP tools need a session; a cell that calls a tool comes with the actor and the role of a run (PBK-P3B-TOOL).

## Limits

1000 step executions per run (a flow stored outside the save path with an undocumented loop stops there with `step_limit_exceeded`), 4 runs at once and one per playbook (`playbook_run_busy`), 256 Ki characters of output per step, stdout and stderr together (the rest is dropped as it arrives, so memory stays bounded however the script prints, NUL and other control characters included, and the output ends with `[truncated]`; the characters count as printed, before any cleaning), `maxRunsToKeep` succeeded or failed runs per playbook. A run that `needs_review` is not pruned and does not count in `maxRunsToKeep`: its journal is the evidence of an effect nobody has examined. No route resolves it yet; it goes away only with its playbook. To keep the disk bounded without deleting evidence, at most 50 runs may await a review across all playbooks: at that count a new run is refused with `playbook_review_backlog` (retry `never`), nothing is written and no run is deleted.

Order of the output treatment: the shape-based layer, then the masker on the output as printed (a secret that holds a CR, LF, tab or NUL is recognised whole, on stdout and on stderr), then the removal of the control characters. A secret too long for one regular expression is found by string search; the masker never throws.

A token is checked in its place again at run time: the output of a step never reaches the arguments or the environment of a script, whatever the way the flow was stored.
