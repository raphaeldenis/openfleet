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
is the newest migration the copy holds, i.e. the newest app version that can open it. The 3 most recent
copies are kept; nothing outside `backups/` and no file that does not match that exact name is ever deleted.
A backup that cannot be written refuses the boot: a migration without a backup is the data-loss case. A fresh
database is not backed up.

A database newer than the code (an older app started on it) is refused, and the line says where to go: quit the
app, copy the newest file in `<home>/backups/` over `openfleet.db` (delete `openfleet.db-wal` and `-shm` first), or
install the newer app. Dev daemons should use their own `OPENFLEET_HOME` so they never migrate the packaged app's db.

The per-file checksum (`schema_migrations.checksum`) catches an already-applied migration whose file was
accidentally or by-hand edited after the fact (line endings/BOM alone never trip it — normalized away
before hashing). It does not protect against someone with direct write access to the database, who can
just null out or rewrite the stored checksum.
