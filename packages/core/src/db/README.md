# Migration checklist (A15)

Before merging a new `NNN_*.sql` migration:
- [ ] Runs clean against a fresh `:memory:` database (covered by `migrate.freshdb.test.ts` — no per-migration test needed, it discovers new files automatically).
- [ ] Any new index needed by this phase's queries is created in the SAME migration as the column/table it indexes, before any backfill that would scan by it.
- [ ] A backfill touching more than ~500 existing rows runs in keyset-paginated batches (`WHERE id > ? ORDER BY id LIMIT 500`), not one unbounded `UPDATE`/`INSERT ... SELECT`.
- [ ] `STRICT` tables, `TEXT` primary keys (app-generated ids), `TEXT` timestamps (ISO strings) — matches 001/002.
- [ ] File is named `NNN_<subject>.sql` with no gaps (enforced by the test above).
- [ ] Never rename or edit a migration once it has shipped — add a new migration instead.

The per-file checksum (`schema_migrations.checksum`) catches an already-applied migration whose file was
accidentally or by-hand edited after the fact (line endings/BOM alone never trip it — normalized away
before hashing). It does not protect against someone with direct write access to the database, who can
just null out or rewrite the stored checksum.
