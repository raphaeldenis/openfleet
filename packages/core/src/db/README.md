# Migration checklist (A15)

Before merging a new `NNN_*.sql` migration:
- [ ] Runs clean against a fresh `:memory:` database (covered by `migrate.freshdb.test.ts` — no per-migration test needed, it discovers new files automatically).
- [ ] Any new index needed by this phase's queries is created in the SAME migration as the column/table it indexes, before any backfill that would scan by it.
- [ ] A backfill touching more than ~500 existing rows runs in keyset-paginated batches (`WHERE id > ? ORDER BY id LIMIT 500`), not one unbounded `UPDATE`/`INSERT ... SELECT`.
- [ ] `STRICT` tables, `TEXT` primary keys (app-generated ids), `TEXT` timestamps (ISO strings) — matches 001/002.
- [ ] File is named `NNN_<subject>.sql` with no gaps (enforced by the test above).
- [ ] Never rename or edit a migration once it has shipped — add a new migration instead.

## Backup before a migration, and going back

When a boot finds pending migrations on a database that already applied some, `openDatabase` first writes a
consistent copy to `<home>/backups/openfleet-<schemaVersion>-<ISO timestamp>.db` (`VACUUM INTO`, WAL-safe,
mode 0600, folder 0700) plus `config.json` beside it as `<same name>.config.json`, and logs the path. `<schemaVersion>`
is the newest migration the copy holds, i.e. the newest app version that can open it.

The pre-upgrade marker: the first boot of an upgrade that takes a backup also writes `backups/pre-upgrade.marker`
(mode 0600, created through a temp name and renamed into place) holding the exact file name of that boot's
snapshot and nothing else. The marker is valid only while an upgrade is in flight and migrations committed since
the marked snapshot, three rules:

- R1: a boot with no pending migration deletes any marker and takes no backup (no upgrade is in flight; this also
  cleans a marker left by a crash between the last migration and its clearing).
- R2: a boot with pending migrations keeps the marker only if it names an existing regular-file backup of a shipped
  schema version that is strictly older than the newest migration the database has applied now (a migration
  committed since: a partial streak, so during a streak the marker keeps naming the snapshot taken before the first
  attempt). Otherwise it is replaced by this boot's snapshot: a version equal to the database's means nothing
  committed since (the snapshot taken now is equivalent, or holds newer data when the old app was used in between,
  for example after restoring the marked snapshot). A missing file, an invalid name, a symlink or a directory
  never counts as valid; a symlink is replaced, never followed, and a marker that cannot be written (a directory
  in its place) is ignored and the hint names this boot's snapshot.
- R3: the marker stays deleted after a successful upgrade boot. That boot's pruning still keeps the snapshot the
  upgrade started from, so a user can roll back after a "successful" upgrade; the next boot that takes a backup
  prunes it by the usual rule below.

Every hint (failed migration, database newer than the code) applies the same validity test before naming a snapshot.

Retention (a deliberate departure from "the 3 most recent backups"): the newest backup of each of the 3 most
recent schema versions, plus the pre-upgrade snapshot, each with its `.config.json` copy. Disk bound: 3 versions
+ the pre-upgrade snapshot + the backup just taken (which only adds a file when a restored older backup makes it
older than the 3 retained versions), so at most 5 `.db` files of shipped versions. Only schema
versions this app ships count: a file named like a backup whose version is not a shipped migration (a dev
build or beta, `999_x`, `zzz`) takes no slot, is never named in a hint and is never deleted. The schema version is the one in the
file name, compared as text like the migration file names themselves (hence the fixed 3-digit `NNN_` prefix),
never by clock or file date, so a clock rollback cannot evict a version. Within one schema version the newest
wins (the backup just taken always counts as the newest). Pruning runs on every boot that took a backup,
including boots whose migration then fails, and once more after the success. Nothing
outside `backups/` and no file that does not match that exact name is ever deleted. A backup that cannot be written
refuses the boot: a migration without a backup is the data-loss case. A fresh database is not backed up.

Going back: quit the app, delete `openfleet.db-wal` and `openfleet.db-shm`, then copy the `.db` backup over
`openfleet.db` (never a `.config.json` copy, which only holds the settings). A failed migration names the valid marked
pre-upgrade snapshot by its exact file name (this boot's snapshot otherwise), the file the previous
app opens with all the data written before the upgrade. A database newer than the code (an older app started on it)
is refused and the line names the valid marked snapshot, else the newest backup this app can open, or the file name pattern
`openfleet-<newest known migration>-<timestamp>.db` when none exists; or install the newer app. Dev daemons should
use their own `OPENFLEET_HOME` so they never migrate the packaged app's db.

The per-file checksum (`schema_migrations.checksum`) catches an already-applied migration whose file was
accidentally or by-hand edited after the fact (line endings/BOM alone never trip it — normalized away
before hashing). It does not protect against someone with direct write access to the database, who can
just null out or rewrite the stored checksum.
