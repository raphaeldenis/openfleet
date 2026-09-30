import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { sha256Hex } from './migrate.js';

const migrationsDirectory = new URL('./migrations/', import.meta.url);

// A shipped migration is immutable: databases in the field already applied it. Adding a migration means
// adding its line here; editing a line below means a shipped file was edited, which is never allowed.
const SHIPPED_MIGRATION_CHECKSUMS: Record<string, string> = {
  '001_init': '44f927963249933d4d9c7f5c4ea9680a915f014c12a11aadf24ade3a69f93abd',
  '002_managers': '4bd21ac27fa91bcd0c116639000a896444aa12bf775e0e3277c80aa54212cf8f',
  '003_session_branch': '3218997e857540547fd928038a365a20f522d8b15b1c83d8c2fa023bceea231d',
  '004_session_directory_realpath': 'c8a199062976fde8c2455e05fe1247d381b10f31a18827375bfe301594ccbf70',
  '005_projects': 'f4ca98d2963a26666f7334043c83f5c30b5baf66b1ae0a5cfa81dbfe33a9b79f',
  '006_notes': 'd6a554daaf59fc7654db491655eb81a20e073c6e14e246fed94df2547ab0473b',
  '007_data_stores': '5fd3b1f26b66097fa3596014a135073e22827c49c2e7b9c9967ec82d3ae7d50e',
  '008_schema_migrations_checksum': 'e155f16e0a423268fa9e3644754971822be019408c4781c868dbc3ffed7db929',
  '009_session_resolved_model': '46de3a34b1eb3db716419ca1af61133459b8a491b7228b3722bf44d4d7c14094',
  '010_ds_column_auto_value': 'c0f12115d469d9f352cf06da2843c6d996819492f12288aa4556c4907243fa8c',
  '011_session_resolved_for_model': '0bcf10f75553c3b6c2b660bf91d0dc92d9df9c15cc5a0b9a1413f69aa42d3e1f',
  '012_session_cli_session_id': '3db7b22c96cf6c5875ee7f9e6a24d479263b5ea3d74b28331bccb5c259c2d230',
  '013_working_state': '8e9dca9ccb0ce42f093f0c95575977abc1c80f5f7842a2a51e1d1328bd6a7234',
  '014_session_cli_ids': '604d2c2eaf674815bfce180542353f34f37a1c904649aa41fcddc235b000b235',
  '015_handovers': 'bdd9164d79d37ab3e883413646afc4ac4b82bf1be6f00cff763bce24e4914ce2',
  '016_session_prompted_events_index': '295c9bcb756025c9a81d7d59a3270191255c13c40e8900581dcf535dfa02f398',
};

const migrationVersionsOnDisk = () =>
  readdirSync(migrationsDirectory)
    .filter((fileName) => fileName.endsWith('.sql'))
    .map((fileName) => fileName.replace(/\.sql$/, ''))
    .sort();

const checksumOnDisk = (version: string) => sha256Hex(readFileSync(new URL(`${version}.sql`, migrationsDirectory), 'utf8'));

const immutabilityMessage = (versions: string[]) =>
  `shipped migrations are immutable: add a NEW NNN_*.sql file instead of editing ${versions.map((version) => `${version}.sql`).join(', ')}`;

describe('shipped migrations', () => {
  it('are pinned: every migration file has its checksum listed in this test, so a new migration must add its own line', () => {
    const unpinnedVersions = migrationVersionsOnDisk().filter((version) => !(version in SHIPPED_MIGRATION_CHECKSUMS));

    expect(unpinnedVersions, `migration(s) ${unpinnedVersions.join(', ')} have no pinned checksum: add a line to SHIPPED_MIGRATION_CHECKSUMS in migrate.pinnedChecksums.test.ts`).toEqual([]);
  });

  it('are unedited: no shipped migration file differs from its pinned checksum', () => {
    const pinnedVersionsOnDisk = migrationVersionsOnDisk().filter((version) => version in SHIPPED_MIGRATION_CHECKSUMS);

    const editedVersions = pinnedVersionsOnDisk.filter((version) => checksumOnDisk(version) !== SHIPPED_MIGRATION_CHECKSUMS[version]);

    expect(editedVersions, immutabilityMessage(editedVersions)).toEqual([]);
  });

  it('are all still present: no pinned migration file was deleted or renamed', () => {
    const versionsOnDisk = new Set(migrationVersionsOnDisk());

    const missingVersions = Object.keys(SHIPPED_MIGRATION_CHECKSUMS).filter((version) => !versionsOnDisk.has(version));

    expect(missingVersions, immutabilityMessage(missingVersions)).toEqual([]);
  });
});
