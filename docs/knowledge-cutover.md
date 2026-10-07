# Knowledge ownership cutover

MEM-01 imports curated facts from a JSON snapshot. The daemon never connects to
Postgres. Rehearsal keeps Postgres authoritative. Final import marks the local
repository `frozen`; a separate offline activation transfers authority to `native`.
No knowledge write MCP tool or REST route exists in MEM-01.

## Prerequisites and freeze

The Lead names the operator and schedules UTC activation time T for each repo.
MEM-02 must be delivered and accepted before the final freeze begins. Record the
accepted delivery reference and the human acceptance evidence in the cutover record.
The command-line acknowledgement refers to that evidence; it cannot prove acceptance
and the source export cannot supply it.

At T−2 hours, the operator blocks INSERT, UPDATE and DELETE for the transferring
repo through every Postgres writer, drains in-flight transactions, and verifies
write refusal with each real writer identity. A manifest flag alone does not freeze
writers. Keep Postgres frozen until activation or an explicitly approved abort.

Export a consistent snapshot of **all** `memory.knowledge` rows, including retired
rows. Exporting only `memory.active_knowledge` loses history and is unacceptable.
Keep the raw snapshot outside the repository in an operator-controlled regular file
with mode 0600. It may contain credentials. No import command edits this source.

## Snapshot and mapping

The version 1 snapshot contains `source: "scape_team.memory.knowledge"`, a textual
`snapshot_id`, UTC `exported_at`, nullable UTC `frozen_at`, boolean
`freeze_verified`, `repos`, and `rows`. Each repo manifest entry has `repo`, `count`,
`active_count`, and `retired_count`. Each row has textual `id` and `repo`, `area`,
`fact`, nullable `source_task`, `source_kind`, `verified_by`, UTC `created_at`,
nullable UTC `retired_at`, and nullable `retired_why`. An active row has no retirement
reason. Serialize numeric source IDs as strings without losing precision.

Rehearsal uses `frozen_at: null` and `freeze_verified: false`. Final import requires
the actual freeze timestamp, `freeze_verified: true`, and matching complete counts.
Every date and row is validated before import writes. UTC timestamps are normalized
to ISO strings. Inputs are capped at 32 MiB and 50,000 rows; fact text at 8 KiB,
each area/provenance/reason field at 1 KiB, and structural IDs at 512 UTF-8 bytes.
Oversize content is refused rather than truncated.

Migration 025 remains immutable. Additive migration 026 extends
`knowledge_import_runs` with nullable `snapshot_digest` and `mem02_acceptance`;
historical runs keep null values. Run IDs remain opaque generated TEXT UUIDs.
`knowledge_import_mappings` records each run's source repo, project, stable key,
canonical root and Git common directory, with foreign keys and no cascade. This
history detects a source repo remapped completely into another project. Existing
imported rows without this provenance require explicit operator reconciliation;
the importer cannot invent their source mapping.

The internal SHA-256 digest covers normalized UTC snapshot metadata, sorted
canonical mapping identities, deterministic fact IDs and fingerprints of masked
fact/provenance/retirement fields. Sorting uses lexical comparison, independent of
locale. JSON whitespace and row order do not change snapshot identity. Different
raw credentials that mask to the same stored fields have the same masked content
identity. Digests are never printed. Final runs record the independently supplied
MEM-02 reference after masking; an export cannot certify acceptance.

The separate mapping file is:

```json
{
  "version": 1,
  "repos": [{
    "source_repo": "source-repo",
    "project_id": "existing-openfleet-project-id",
    "repo_key": "approved-stable-key",
    "canonical_root": "/absolute/local/git/root"
  }]
}
```

Each source repo has exactly one mapping. Projects preexist. Git roots and common
directories are canonicalized; project names and directory basenames do not infer
identity. Facts receive deterministic namespaced IDs, preserving separate source
IDs even when fact text is identical.

## Rehearsal and final import

Use Node 26 or newer and the built daemon entry; the desktop GUI executable does
not install a standalone `openfleet` command. Quit the target daemon first. All
paths below are absolute operator-chosen paths; use a fixture home for rehearsal.

```sh
node /absolute/daemon.mjs import knowledge --file /absolute/snapshot.json --mapping /absolute/mapping.json --home /absolute/fixture-home --dry-run
node /absolute/daemon.mjs import knowledge --file /absolute/snapshot.json --mapping /absolute/mapping.json --home /absolute/fixture-home --report-file /absolute/docs/rehearsal-report.json
```

A missing target project is a refusal. Dry-run creates no target home, database,
backup or report. Source and report paths cannot traverse symbolic links. Reports
use numbered repository slots in mapping order rather than echoing names or paths.
They contain counts and fixed rejection reasons, never facts, source IDs,
credentials, fingerprints or exception stacks.

Dry-run reads an existing database without migrating it. Upgrade an older target
schema through the normal application migration path before rehearsal. The offline
exclusivity probe rejects a daemon using the target; fact planning uses a read-only
connection. Actual import and activation retain an exclusive target lock through
their write boundary. Knowledge import suppresses migration path logs with a named
open policy; ordinary daemon migration logs retain their existing behaviour.
The offline transaction also suppresses raw rollback diagnostics through a named
failure policy. Rollback, target-close and report-file failures produce fixed
rejection reasons; `committed` distinguishes an accepted DB transaction from a run
that writes no facts.

After the real freeze and complete export, compare the dry-run counts with the
operator's export record. Supply the independent accepted MEM-02 delivery reference:

```sh
node /absolute/daemon.mjs import knowledge --file /absolute/final.json --mapping /absolute/mapping.json --home /absolute/target-home --dry-run --final --mem02-acceptance MEM-02-accepted-delivery
node /absolute/daemon.mjs import knowledge --file /absolute/final.json --mapping /absolute/mapping.json --home /absolute/target-home --final --mem02-acceptance MEM-02-accepted-delivery --report-file /absolute/docs/final-report.json
```

The complete file imports in one atomic transaction. Compare `source_rows` with
`inserted + updated + unchanged`, and `source_active + source_retired` with
`source_rows`, both globally and per repo. A failed import never sets `native`.
An import that commits but cannot save its report returns `committed: true` with
`REPORT_WRITE_FAILED`; preserve stdout and investigate report access. Exact replay
is safe and does not add a duplicate successful import run.

Before activation, a changed source updates only an intact imported target. Local
edits, deleted targets, absent source IDs and changed mappings are conflicts; the
entire run aborts. The importer does not reconcile deletions by deleting facts.
Resolve conflicts explicitly before accepting a final snapshot.
An exact frozen replay writes nothing. A changed frozen snapshot requires another
validated `--final` run before activation.

Imported free text is masked with `maskedSecrets` before SQLite storage and FTS
indexing. Known credential formats are protected. Short, numeric and unknown
credential formats can remain readable; this is not an exhaustive secret scanner.
Content stays out of reports even when the masker leaves residue.

## Activation and rollback

Final import is not activation. After validating identities, counts and fixture
search smoke results, stop the daemon again and explicitly activate the same files:

```sh
node /absolute/daemon.mjs import knowledge --file /absolute/final.json --mapping /absolute/mapping.json --home /absolute/target-home --activate --mem02-acceptance MEM-02-accepted-delivery --report-file /absolute/docs/activation-report.json
```

Activation validates the sealed snapshot and every current imported target before
setting `authority=native` and `activated_at` atomically. It is offline and cannot
be invoked via MCP or REST. After activation, only exact sealed replay is accepted;
changed snapshots, mappings or native fact edits cause refusal, without repair.
Update operator missions and MCP cutover configuration so Postgres knowledge is no
longer an alternate live fact source for transferred repositories. Unrelated
Postgres data is unaffected. Retain the frozen source snapshot for the existing
14-day rollback window.

Rollback requires an explicit human ownership decision. Stop native writers first,
export and reconcile native changes made through MEM-02, then obtain approval
before unfreezing Postgres. Restarting Scape managers does not authorize a stale
Postgres writer. The general Scape rollback plan alone does not reconcile facts.
