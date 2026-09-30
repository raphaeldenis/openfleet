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
snapshot and nothing else. While the marker names a backup that still exists, has a shipped schema version and
matches the backup name pattern, later boots keep it, so during a streak of failed boots the marker keeps naming the
snapshot taken before the first attempt (later boots take snapshots of a schema a failed boot already partly
migrated). A marker naming a missing file or an invalid name, or being a symlink, is replaced (never followed); a
marker that cannot be written (for example a directory in its place) is ignored and the hint names this boot's
snapshot. The marker is deleted after the first boot that applies every migration.

Retention (a deliberate departure from "the 3 most recent backups"): the newest backup of each of the 3 most
recent schema versions, plus the marked pre-upgrade snapshot (never pruned while the marker names it), so 3
versions plus the pre-upgrade snapshot, each with its `.config.json` copy (the backup just taken is also kept,
which only adds a file when a restored older backup makes it older than 3 retained versions). Only schema
versions this app ships count: a file named like a backup whose version is not a shipped migration (a dev
build or beta, `999_x`, `zzz`) takes no slot, is never named in a hint and is never deleted. The schema version is the one in the
file name, compared as text like the migration file names themselves (hence the fixed 3-digit `NNN_` prefix),
never by clock or file date, so a clock rollback cannot evict a version. Within one schema version the newest
wins (the backup just taken always counts as the newest). Pruning runs on every boot that took a backup,
including boots whose migration then fails, and once more after the success, once the marker is gone. Nothing
outside `backups/` and no file that does not match that exact name is ever deleted. A backup that cannot be written
refuses the boot: a migration without a backup is the data-loss case. A fresh database is not backed up.

Going back: quit the app, delete `openfleet.db-wal` and `openfleet.db-shm`, then copy the `.db` backup over
`openfleet.db` (never a `.config.json` copy, which only holds the settings). A failed migration names the marked
pre-upgrade snapshot by its exact file name (this boot's snapshot when there is no marker), the file the previous
app opens with all the data written before the upgrade. A database newer than the code (an older app started on it)
is refused and the line names the marked snapshot, else the newest backup this app can open, or the file name pattern
`openfleet-<newest known migration>-<timestamp>.db` when none exists; or install the newer app. Dev daemons should
use their own `OPENFLEET_HOME` so they never migrate the packaged app's db.

The per-file checksum (`schema_migrations.checksum`) catches an already-applied migration whose file was
accidentally or by-hand edited after the fact (line endings/BOM alone never trip it — normalized away
before hashing). It does not protect against someone with direct write access to the database, who can
just null out or rewrite the stored checksum.
