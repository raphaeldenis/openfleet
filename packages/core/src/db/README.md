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

Retention (a deliberate departure from "the 3 most recent backups"): the newest backup of each of the 3 most
recent schema versions is kept, so at most 3 `.db` files plus their `.config.json` copies. The schema version is
the one in the file name, ordered by migration name, never by clock or file date, so a clock rollback or failed
retries cannot evict the snapshot from before an upgrade. Within one schema version the newest wins (the backup
just taken always counts as the newest). Pruning runs on every boot that took a backup, including boots whose
migration then fails. Nothing outside `backups/` and no file that does not match that exact name is ever deleted.
A backup that cannot be written refuses the boot: a migration without a backup is the data-loss case. A fresh
database is not backed up.

Going back: quit the app, delete `openfleet.db-wal` and `openfleet.db-shm`, then copy the `.db` backup over
`openfleet.db` (never a `.config.json` copy, which only holds the settings). A failed migration names the snapshot
from before the upgrade (the oldest retained backup older than the newest shipped migration, the one the previous
app opens). A database newer than the code (an older app started on it) is refused and the line names the newest
backup this app can open, or the file name pattern `openfleet-<newest known migration>-<timestamp>.db` when none exists; or
install the newer app. Dev daemons should use their own `OPENFLEET_HOME` so they never migrate the packaged app's db.

The per-file checksum (`schema_migrations.checksum`) catches an already-applied migration whose file was
accidentally or by-hand edited after the fact (line endings/BOM alone never trip it — normalized away
before hashing). It does not protect against someone with direct write access to the database, who can
just null out or rewrite the stored checksum.
