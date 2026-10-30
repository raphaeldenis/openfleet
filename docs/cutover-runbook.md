# Scape to OpenFleet cutover runbook (MIG-CUTOVER-RUNBOOK01)

This runbook moves the managers, notes and tables from Scape to OpenFleet. Every
step and every claim carries exactly one label:

| Label | Meaning |
| --- | --- |
| **VERIFIED** | Played in the rehearsal CUTOVER-REHEARSAL01 (2026-10-30) or visible in an import report. The source file and section are cited. |
| **UNVERIFIED** | Could not be traced to a source. |
| **PLANNED** | Written in the cutover plan, never played. The expected result is a hypothesis. |
| **OWNER** | Needs the owner's green light or the owner's own hands. No agent does it. |

Paths are generic: `<home>` is the target OpenFleet home, `<report-dir>` a scratch
directory, `<scape-dir>` the Scape home, `<residue-home>` a set-aside old home.
Never put the content of real databases, tokens or `.env` files in a report.

Source keys used below. All files sit under `scape-team/migration/`.

| Key | File |
| --- | --- |
| **REH** | `report-2026-10-30/REHEARSAL.md`, "Steps and evidence" (step number cited) |
| **REP2** | `report-2026-10-30/import-report-2.md`, the re-import of the rehearsal |
| **OLD** | `report-2026-10-28/import-report.md`, the import into the previous home |
| **CLI** | `packages/core/src/import/importCli.ts` in this repository |

REH, REP2 and OLD live outside the repository (`scape-team/migration/`). A reader
without access to that folder cannot open them; the facts cited from them are
the owner's and the manager's record, not reproducible from the repository.

**Global scope of VERIFIED.** Every VERIFIED step below holds for the rehearsal
commit `875fc1e0`. A second pass on current `main` (with PR #381, PR #382 and
migration 061) is **UNVERIFIED**.

## State of the evidence (État de la preuve)

| Label | What it covers |
| --- | --- |
| **VERIFIED** | Old home set aside, nothing deleted (REH 1). Dry run and real import on a fresh home (REH 3, 4). Daemon boot from sources, `/health` 200 on two starts, migrations 001 to 060 at `875fc1e0` (REH 5; `main` expects 001 to 061, **UNVERIFIED**). Idempotent re-import with 0 conflict (REH 6, REP2). 7 managers, 39 laws, 99 memories (REH 4, REP2). Import flags (CLI). PR #381 merged. |
| **UNVERIFIED** | The raw report of the real import (see the warning in section 1). Pulse and cap of the 7 managers. Boot of the packaged app on the imported home (the rehearsal used the daemon from sources). B2 human reading. Ticket statuses beyond REH "Known gaps". |
| **PLANNED** | Scape freeze, Scape backup, manager start, hand-over of work in flight, 14-day rollback, B5, B8. |
| **OWNER** | Branch protection on `main`, release, decisions D1 to D5, Scape freeze window, `~/.claude.json`, reading the 7 missions (REH 7: pending), disposal of the set-aside home. |

Two facts to keep in mind:

- The cutover plan of 2026-10-04 counts 3 managers. It predates four managers
  (Aletheia, Plume, Mnémosyne, Yuri&Neil). `arguses.json` holds 7 today and both
  reports follow it (REH "Why 7 managers, not 3"). The plan's 3 is historical.
- `get_manager_mission` is on `main` (PR #382, merged as `2fa631fc`;
  STATUS-NO-MISSION-BODY01 is merged). The rehearsal ran before it, so the
  imported missions of the rehearsal still pointed to `get_argus_status`. The
  behaviour on a fresh import from `main` is **UNVERIFIED**.

## 1. What the rehearsal established

The rehearsal ran on 2026-10-30 in a worktree of this repository based on
`origin/main` at `875fc1e0` (REH header). All times UTC.

**Warning on the reports.** `import-report.md` and `import-report-2.md` in the
rehearsal folder are byte-identical (`cmp` returns no difference). Both are the
re-import report. The raw report of the first real import was overwritten, so its
counts below rest on REH step 4 alone, not on a report file.

### Counts

| Entity | First import (REH 4) | Re-import (REP2) | Previous home (OLD) |
| --- | --- | --- | --- |
| projects | 6 | 6 present | 6 |
| notes | 147 | 147 present | 130 |
| noteVersions | 465 (6 not converted) | 464 present, 1 updated | 428 |
| playbooks (archived as inert notes) | 48 | 38 present, 10 updated | 48 |
| dataStores / columns / views | 27 / 318 / 7 | same, all present | 27 / 318 / 7 |
| rows | 12 222 | 12 217 present, 5 written, 5 updated | 10 839 |
| history | 5 382 | 5 366 present, 11 written, 13 removed in Scape (kept) | 4 924 |
| managers | 7 (2 not converted) | 7 present | 7 |
| workingStates | 6 | 6 present, 1 written | 0 |
| memories | 99 | 99 present | 0 |
| laws | 39 | 39 present | 39 |

The previous home (OLD) is not the rehearsal: it held 7 managers imported on
2026-10-28 plus 23 phase-2 QA managers, with working states and memories at 0 (REH 1,
OLD). Counts move as Scape keeps running; the report of the run on the day is the
oracle, not this table.

### Gaps found by the rehearsal

| Finding (REH) | Ticket | State |
| --- | --- | --- |
| The real import was started by `--json` without `--dry-run`; `--json` wrote. | IMPORT-CLI-JSON-WRITES01 | merged, PR #381 (`--json` is now a forced dry run, CLI) |
| Mnémosyne's state file was not found: the accent produced the stem `mn-mosyne`. The rehearsal copied the state file under that name as a workaround. | IMPORT-STATE-ACCENT01 | merged, PR #381; the copy is no longer needed |
| Mnémosyne and Yuri&Neil have no model on their Scape cards and were not converted. | IMPORT-MANAGER-MODEL-DEFAULT01 | merged, PR #381 (a missing model defaults to `sonnet`) |
| 6 view sort settings are dropped. | IMPORT-VIEW-SORT01 | open: REH says "to create", the manager's brief says in progress |
| Lexical leftovers. | IMPORT-LEXICAL-LEFTOVERS01 | same as above |
| `sqlite3 -readonly` fails with "unable to open database file (14)" on the live database after the re-import; the URI form `file:<path>?immutable=1` works. Cause not investigated. | none | **UNVERIFIED** cause |
| The packaged app bundles a daemon older than migration 060. | none | do not open it on this home |

The fixes of PR #381 were merged after the rehearsal. The rehearsal did not run
with them, so the rehearsal evidence does not cover them. **UNVERIFIED** until a
second run on `main`.

### Manager missions

6 of the 7 missions are over 8 192 bytes (every manager except Plume, REP2
"Manager missions"). They are imported as they are; the ceiling is not a refusal
at import time. **VERIFIED** (REP2, OLD).

## 2. Preconditions

| # | Precondition | Label |
| --- | --- | --- |
| P1 | The target home is new. The previous home held 30 managers (7 imported plus 23 QA residue) and was moved to `<residue-home>`; nothing was deleted (REH 1). An agent never deletes it. | **VERIFIED** (move); **OWNER** (disposal) |
| P2 | No process holds the old home and nothing listens on 7331 or 7332 before the move (REH 1: `lsof` on the folder was empty). The exact commands are not recorded. | **VERIFIED**, commands **UNVERIFIED** |
| P3 | `main` holds PR #381. | **VERIFIED** (merge commit `c9f537d4`) |
| P4 | The importer never writes to `<scape-dir>`. This holds for the Scape home only. | **PLANNED** (plan section 3) |
| P4b | The import has side effects outside the OpenFleet home: it **writes** the manager memories (99 in the rehearsal) under `<claude-dir>/projects/<manager folder>/memory` (`--claude-dir`, default the user's Claude config folder) and **reads** the manager state files from `<state-dir>` (`--state-dir`, default the Scape team state folder). Pass both paths explicitly. | **VERIFIED** (CLI usage text; REH 4 counts 99 memories) |
| P5 | A backup of the Scape home exists before the final import, and the disk has room for it. | **PLANNED** |

## 3. Step table

Run one command at a time and stop at the first unexpected result.

| # | Step | Command | Expected result | Label |
| --- | --- | --- | --- | --- |
| 1 | Open the freeze window on Scape: no new spawn from T-2 h; children report and close. | none | no Scape session is spawned after T-2 h | **OWNER**, **PLANNED** |
| 2 | Disable the Scape manager cards, quit Scape. | none | Scape has no live session | **OWNER**, **PLANNED** |
| 3 | Back up the Scape home. | `cp -a <scape-dir> <scape-dir>-backup-<date>` | backup exists, same size as the source | **PLANNED** |
| 4a | Inspect the old target home before moving it. On the day it can hold real work, notably the OpenFleet backlog. Stop the daemon and the app, check ports 7331 and 7332 are free, and check the disk has room for the step 3 backup. | `ls <home>`; check for listeners on 7331 and 7332 | nothing runs on the home; ports free; enough disk space | **VERIFIED** for the rehearsal (REH 1: `lsof` on the folder empty, no listener); exact commands **UNVERIFIED**; the day-J checks are **PLANNED** |
| 4b | Set the old target home aside. | `mv <home> <residue-home>` | `<home>` absent; nothing deleted | **VERIFIED** (REH 1) |
| 5 | From the repository checkout used for the import, update `main` and install dependencies. | `git checkout main && git pull`, then `pnpm install --frozen-lockfile` | "Lockfile is up to date" | `pnpm install` **VERIFIED** (REH 2, worktree at `875fc1e0`); the `main` update is **PLANNED** |
| 6 | Dry run, text report. Pass `--state-dir` and `--claude-dir` explicitly (P4b). | `OPENFLEET_HOME=<home> pnpm --filter @openfleet/core import:scape --home <home> --dry-run --report-dir <report-dir> --state-dir <state-dir> --claude-dir <claude-dir>` | exit 0, no error, no conflict; **no file** in `<report-dir>` | **VERIFIED** (REH 3, run twice; CLI) |
| 7 | Real import. | same command without `--dry-run` | exit 0; `import-report.md` in `<report-dir>`; `written` equals `expected` for every entity | **VERIFIED** (REH 4) with the old `--json` trigger; the command without `--json` is **UNVERIFIED** until rerun on `main` |
| 8 | Read the report. | read `<report-dir>/import-report.md` | `conflict = 0`; managers 7 | **VERIFIED** (REP2) |
| 9 | Boot the daemon from sources, with `nohup` or in a second terminal; note the pid. | `OPENFLEET_HOME=<home> pnpm --filter @openfleet/core exec tsx src/main.ts` | one line "listening on http://127.0.0.1:7331", 0 errors; migrations applied | **VERIFIED** at `875fc1e0` (REH 5: 001 to 060); `main` expects 001 to 061 (`061_plan_question_reopens_index.sql`), **UNVERIFIED** |
| 10 | Check health (B7). | `GET http://127.0.0.1:7331/health` | HTTP 200 on a first and a second start | **VERIFIED** at `875fc1e0` (REH 5); on `main` with migration 061, **UNVERIFIED** |
| 11 | Stop the daemon. | `kill -TERM <pid>` (the pid noted at step 9) | port 7331 free afterwards | **VERIFIED** (REH 5) |
| 12 | Check counts with a read-only query, after the daemon is stopped. The database is in WAL mode: `immutable=1` ignores the WAL, so a query while the daemon runs returns stale counts. | `sqlite3 "file:<home>/openfleet.db?immutable=1"` with count queries | managers 7, projects 6, data_stores 27, ds_rows 12 222 (before the re-import) | the counts **VERIFIED** (REH 5); the order after the stop is a correction of this runbook, **UNVERIFIED** |
| 13 | Re-import to prove idempotence (B1). Copy the first report out of `<report-dir>` first. | the step 7 command with `--allow-reimport` (dry run first, then real) | 0 conflict; managers 7/7, projects 6/6, notes 147/147, stores 27/27 present. At `875fc1e0` only records changed in Scape were written. On `main` an intact imported manager is rewritten (reported `updated`, the laws are no longer copied into the mission, CLI `REIMPORT_NOTE`) | **VERIFIED** at `875fc1e0` (REH 6, REP2); behaviour on `main` **UNVERIFIED**. `import scape clean-laws --home <home>` prints a cleanup plan for the laws copies in the missions; `--apply --confirm <fingerprint>` is refused while the daemon runs (CLI usage). Not played |
| 14 | Read the 7 missions in the app, started from sources. | open each manager | missions complete | **OWNER** (REH 7: pending) |
| 15 | Remove `notify.sh` from the global hooks; register the external MCP servers (`docs/mcp-servers-at-cutover.md`). | `claude mcp list` | `repowise`, `playwright-qa`, `scape-postgres` listed | **OWNER**, **PLANNED** |
| 16 | Start the managers. The way to start an imported manager (session start from the app, then a first pulse) is not recorded in any source. Then read the status and write a first log row with the OpenFleet tools `get_argus_status` and `insert_data_store_rows`, and read the data with `query_data_store` (OpenFleet tool, `packages/core/src/mcp/tableTools.ts`). | MCP `get_argus_status`, `insert_data_store_rows`, `query_data_store` | managers listed; one new log row | start procedure **UNVERIFIED**; the rest **PLANNED** |
| 17 | Hand over work in flight (PRs, MRs). | MCP `send_session_message` | each manager acknowledges the worktree and PR | **PLANNED** |
| 18 | Write the cutover note in the OpenFleet project. | MCP `create_note` | note holds date, report reference, rollback deadline | **PLANNED** |

Rules from the rehearsal:

- The report is text. `--json` is a forced dry run: it prints JSON and writes
  nothing (CLI). It cannot serve as the real import.
- A dry run writes no report file. To keep a report, run for real and pass
  `--report-dir`; without it the report goes to the home.
- A second real import on a home that already holds imported projects needs
  `--allow-reimport`. A re-import rewrites `import-report.md`, so copy the first
  report out of `<report-dir>` before running it.
- Never open the packaged app on a home migrated to 060 (REH 7).

## 4. Criteria B1 to B8

| Criterion | Statement (plan section 2) | Status |
| --- | --- | --- |
| B1 | The importer is idempotent. | **VERIFIED** (REH 6, REP2: 0 conflict) |
| B2 | Lexical notes convert to markdown. | Report lists no unconverted lexical type (REP2); 6 note versions are still counted not converted; human reading of the missions is **OWNER** |
| B3 | Managers imported with alias model and approved laws. | 7 managers and 39 laws **VERIFIED** (REH 4, REP2); 2 managers were not converted before PR #381; pulse and cap **UNVERIFIED** |
| B4 | Tables imported with columns, views, history. | **VERIFIED** for counts (REH 4); 6 view sorts dropped |
| B5 | Playbook shims. | **PLANNED**: 48 playbooks archived as inert notes (REH 4); shims in `docs/playbook-shims.md` |
| B6 | Working state seeded from state files. | 6 written plus 1 after the accent workaround (REH 4, 6); in the re-import report 5 of 7 working states are "not converted" (REP2); fixed by PR #381, **UNVERIFIED** on a rerun |
| B7 | The daemon boots on the imported home. | **VERIFIED** for the daemon from sources at `875fc1e0`, migrations 001 to 060 (REH 5); `main` expects 061, **UNVERIFIED**. The plan states B7 on the packaged dmg: that part is **UNVERIFIED** and the packaged app is unusable on this home today (REH 7) |
| B8 | Dual run: three backlog tasks on OpenFleet. | **UNVERIFIED**, never played |

## 5. What the owner does

- Branch protection on `main`, and the release.
- Decisions D1 to D5 of the plan: scope of the first move, whether Scape stays
  installed, day-one integrations, playbooks as shims, history import.
- Opening the Scape freeze window and quitting Scape (steps 1, 2).
- Reading the 7 missions (step 14).
- `~/.claude.json` and the global hooks (step 15).
- Disposal of `<residue-home>`.

## 6. Rollback (14 days)

**PLANNED**, never played.

1. Scape stays installed and read only for 14 days. The import never writes to
   the Scape home.
2. To go back: re-enable the Scape manager cards. Scape transcripts and
   `arguses.json` are untouched. The Scape home backup of step 3 is the restore
   point.
3. Rows written in OpenFleet since the cutover are exported with
   `query_data_store` (OpenFleet tool) and re-entered by hand. No OpenFleet to
   Scape export exists.
4. `<residue-home>` stays on disk until the owner decides. Restoring it is a
   move back to `<home>`; nothing in this runbook deletes it.
5. The import wrote manager memories into `<claude-dir>` (P4b). Rolling back does
   not remove them, and this runbook never advises removing them: the owner
   decides.
6. Last resort: keep the new home as it is, stop the daemon, and return to Scape
   with the step 3 backup.
7. After 14 days: uninstall Scape and keep the archived Scape home.

## 7. Other open items

- `get_manager_mission` is on `main` (PR #382, `2fa631fc`;
  STATUS-NO-MISSION-BODY01 merged). Not exercised by the rehearsal.
- MISSION-SIZE-IMPORT01 closed and the mission-size decision (call it
  "D4-size", not the plan's D4 "playbooks as shims") lifted: source is a message
  from Forge of 2026-10-30 10:43Z, a decision of Forge and not a file.
  **UNVERIFIED** in the repository. Long missions are imported as they are
  (REP2, OLD).
- The rehearsal log of the child session is not shared (it sits outside the
  repository); REH is the source of record.
