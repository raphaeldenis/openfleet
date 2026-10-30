# Scape to OpenFleet cutover runbook (MIG-CUTOVER-RUNBOOK01)

This runbook moves the managers, notes and tables from Scape to OpenFleet. It
separates three kinds of statement, and every step carries exactly one label:

| Label | Meaning |
| --- | --- |
| **VERIFIED** | Played during a rehearsal or visible in an import report, with the evidence named. |
| **PLANNED** | Written in the cutover plan, never played. Treat the expected result as a hypothesis. |
| **OWNER** | Needs the owner's green light or the owner's own hands. No agent does it. |

A claim that could not be traced to a source is marked **UNVERIFIED**.

Paths in this document are generic: `<home>` is the target OpenFleet home,
`<report-dir>` is a scratch directory, `<scape-dir>` is the Scape home. Never put
the content of real databases, tokens or `.env` files in a report.

## 1. What the rehearsal established

Rehearsal CUTOVER-REHEARSAL01 ran on a fresh target home with the daemon started
from sources. Criteria B7 and B1 passed.

- **UNVERIFIED**: the rehearsal's own log is not in the sources read for this
  runbook. The result above comes from the manager's brief. Attach the log
  reference here once it is available.
- **VERIFIED** (import report, first import on a fresh home): every expected record
  was written and none was already present or in conflict. 6 projects, 130 notes,
  428 note versions, 27 data stores, 318 columns, 7 views, 10 839 rows, 7 managers,
  39 laws.
- **VERIFIED** (second report, same home, later source state): a re-import writes
  only what changed in Scape (5 rows written, 5 updated, 11 history entries,
  1 working state) and reports 0 conflicts. This is the idempotence check of B1.
- **UNVERIFIED**: which of the two reports belongs to the rehearsal of the morning
  of 2026-10-30. The first report is dated 2026-10-28 and the second 2026-10-30.

### Expected counts

| Entity | First import (2026-10-28) | Re-import (2026-10-30) |
| --- | --- | --- |
| projects | 6 | 6 |
| notes | 130 | 147 |
| noteVersions | 428 | 465 |
| playbooks (archived as inert text) | 48 | 48 |
| dataStores / columns / views | 27 / 318 / 7 | 27 / 318 / 7 |
| rows | 10 839 | 12 227 |
| history | 4 924 | 5 377 |
| managers | 7 | 7 |
| laws | 39 | 39 |

Counts move as Scape keeps running. The report of the run on the day is the
oracle, not this table.

### Manager missions

The report lists 7 managers: Lead, Forge, Capitaine, Aletheia, Plume, Mnémosyne,
Yuri&Neil. 6 of the 7 missions are over 8 192 bytes (every manager except
Plume). **VERIFIED** (both reports): these legacy missions are imported as they
are. The 8 192-byte ceiling is not a refusal at import time.

## 2. Preconditions

| # | Precondition | Label |
| --- | --- | --- |
| P1 | The target home is new. Managers left in a previous home (23 QA managers from phase 2 sit in the development home, per the cutover plan inventory) are set aside by the owner. An agent never deletes them. | **OWNER** for the move; **UNVERIFIED** for the exact count today |
| P2 | `main` holds the import fixes of PR #381 (`--json` is a forced dry run, accent-folded manager stems, a missing model defaults to `sonnet`, stored manager folders are kept on re-import). | **VERIFIED** (merge commit `c9f537d4`) |
| P3 | Scape is read only for the import. The importer never writes to `<scape-dir>`. | **PLANNED** (cutover plan section 3) |
| P4 | A backup of the Scape home exists before the final import. | **PLANNED** |

## 3. Step table

Each step has a command and an expected result. Run one command at a time and
stop at the first unexpected result.

| # | Step | Command | Expected result | Label |
| --- | --- | --- | --- | --- |
| 1 | Open the freeze window on Scape: no new spawn from T-2 h; children report and close. | none (decision of the owner) | no Scape session is spawned after T-2 h | **OWNER**, **PLANNED** |
| 2 | Disable the three Scape manager cards, quit Scape. | none | Scape has no live session | **OWNER**, **PLANNED** |
| 3 | Back up the Scape home. | `cp -a <scape-dir> <scape-dir>-backup-<date>` | backup directory exists, same size as the source | **PLANNED** |
| 4 | Start from a new target home. | `ls <home>` | empty, or absent | **VERIFIED** (rehearsal, per brief) |
| 5 | Start the daemon from sources. | `pnpm dev:core` (root) with `OPENFLEET_HOME=<home>`. The daemon listens on `127.0.0.1:7331` unless `OPENFLEET_PORT` is set; `dev:core` falls back to another port when 7331 is taken. | process stays up | **VERIFIED** (rehearsal, per brief); command read from `scripts/dev/dev-core.ts` |
| 6 | Check the daemon health (criterion B7). | `curl http://127.0.0.1:7331/health` | HTTP 200, body `{ "ok": true, ... }` | **VERIFIED** (rehearsal, per brief) |
| 7 | Dry run, text output, nothing written. | `import scape --home <home> --scape-dir <scape-dir> --dry-run` | the report is printed; **no file** is written in `<report-dir>` or `<home>` | **VERIFIED** (source `importCli.ts`) |
| 8 | Real import with an explicit report directory. | `import scape --home <home> --scape-dir <scape-dir> --report-dir <report-dir>` | exit code 0; `<report-dir>/import-report.md` exists; `written` equals `expected` for every entity | **VERIFIED** (first report) |
| 9 | Read the report: no conflict, `not converted` explained. | read `<report-dir>/import-report.md` | `conflict = 0`; `Lexical node types not converted: none`; manager rows show 7 managers | **VERIFIED** (both reports) |
| 10 | Re-import to prove idempotence (criterion B1). | same command as step 8 with `--allow-reimport` | `written` stays at 0 for projects, notes, stores, columns, views, managers, laws; only records changed in Scape are written or updated | **VERIFIED** (second report) |
| 11 | Read the manager missions in the app. | open each of the 7 managers | the mission text is present, legacy missions are complete | **OWNER**, **PLANNED** |
| 12 | Remove `notify.sh` from the global Claude hooks and register the external MCP servers (`docs/mcp-servers-at-cutover.md`). | `claude mcp list` | `repowise`, `playwright-qa`, `scape-postgres` are listed | **OWNER** for `~/.claude.json`; **PLANNED** |
| 13 | Start the 3 managers; first log line written from OpenFleet. | `get_argus_status` through the MCP tool | the managers are listed; one new log row written by OpenFleet | **PLANNED** |
| 14 | Hand over work in flight (PRs, MRs) to the managers by message. | `send_session_message` | each manager acknowledges the worktree and the PR | **PLANNED** |
| 15 | Write the cutover note in the OpenFleet project. | `create_note` | note exists with date, import report reference, rollback deadline | **PLANNED** |

### Notes on the import command

- The report is **text**. `--json` is a forced dry run, so it never writes and
  cannot serve as the real import. Use the text report in the runbook.
- A dry run writes no report file. To keep a report, run without `--dry-run` and
  pass `--report-dir`.
- Without `--report-dir`, the report goes to the home. Pass `--report-dir`.
- A second real import on a home that already holds imported projects needs
  `--allow-reimport`.
- `--project <name>` limits the run to one Scape project. Counts for records
  removed in Scape are not reported in such a run.

## 4. Cutover criteria B1 to B8

| Criterion | Statement (cutover plan section 2) | Status |
| --- | --- | --- |
| B1 | The importer reads the Scape home and is idempotent. | **VERIFIED** (second report: no conflict, no duplicate) |
| B2 | Lexical notes convert to markdown without loss. | **VERIFIED** for the report of 2026-10-30 (`Lexical node types not converted: none`); the human reading of the three missions is **OWNER** |
| B3 | Managers imported with pulse, cap, alias model and approved laws. | **VERIFIED** for 7 managers and 39 laws (report); the pulse and cap values are **UNVERIFIED** here |
| B4 | Tables imported with columns, views and history. | **VERIFIED** for the counts in section 1; 6 views lose a sort setting (listed in the report) |
| B5 | Playbook shims. | **PLANNED**: playbooks are archived as inert text (48), shims are in `docs/playbook-shims.md` |
| B6 | Working state seeded from the state files. | **VERIFIED** partly: the second report writes 1 working state and skips 5 (not converted); **UNVERIFIED** which 5 and why |
| B7 | The daemon boots on the imported home. | **VERIFIED** (rehearsal, per brief) |
| B8 | Dual run: the imported Capitaine finishes three backlog tasks on OpenFleet. | **UNVERIFIED**, never played |

## 5. Open import tickets

| Ticket | Status | Effect on the cutover |
| --- | --- | --- |
| IMPORT-CLI-JSON-WRITES01 | merged (PR #381) | `--json` is a forced dry run |
| IMPORT-STATE-ACCENT01 | merged (PR #381) | accented manager names find their state file |
| IMPORT-MANAGER-MODEL-DEFAULT01 | merged (PR #381) | a missing model defaults to `sonnet` |
| MISSION-SIZE-IMPORT01 | closed: decision D4 lifted | long missions are imported as they are |
| STATUS-NO-MISSION-BODY01 | in progress | imported missions must point to `get_manager_mission`; **UNVERIFIED**: the tool does not exist in the sources at `c9f537d4` |
| IMPORT-VIEW-SORT01 | in progress | view sort settings are lost (6 views in the report) |
| IMPORT-LEXICAL-LEFTOVERS01 | in progress | lexical nodes without a markdown form |

The ticket statuses come from the manager's brief. Only the PR #381 content was
checked against the git history.

## 6. What the owner does

These steps are outside every agent's scope.

- Branch protection on `main`, and the release.
- Decisions D1 to D5 of the cutover plan: scope of the first move, whether Scape
  stays installed, day-one integrations, playbooks as shims, history import.
- Opening the Scape freeze window (step 1) and quitting Scape (step 2).
- `~/.claude.json` and the global hooks (step 12).
- Setting aside the residual managers of the target home (P1).
- Reading the imported missions (step 11).

## 7. Rollback (14 days)

**PLANNED**, never played.

1. Scape stays installed and read only for 14 days after the cutover. The import
   never writes to the Scape home.
2. To go back: re-enable the three Scape manager cards. The Scape transcripts and
   `arguses.json` are untouched.
3. Rows written in OpenFleet since the cutover are exported with
   `query_data_store` and re-entered by hand. No OpenFleet to Scape export exists.
4. After 14 days: uninstall Scape and keep the archived Scape home.

## 8. Verification summary

| Area | VERIFIED | PLANNED | OWNER |
| --- | --- | --- | --- |
| Import and re-import | steps 4 to 10 | | |
| Daemon boot | steps 5, 6 | | |
| Freeze, backup | | steps 1 to 3 | steps 1, 2 |
| Machine setup | | steps 12 to 15 | step 12 |
| Dual run (B8), rollback | | section 7 | |
