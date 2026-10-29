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
  '016_session_prompted_events_index': '02acbf348e70452f32eba84d6ad6a8fd961975b71d08c5a4bed6ab4d0771481a',
  '017_session_context_notice': '3f2b58190992f9c7b5d804b01fe461a8cd5029a85503277a9a355f93b66ec578',
  '018_notes_folder_check': '0d0551435968615ae6c9e9b114364ecb5adf10c9aad91e2718a356606f156543',
  '019_session_close_reason': '99e755ad0905083669c3c6d68aa9e18ad034d1eb96070ea071165914b984745d',
  '020_scape_import_ledger': 'a5d945b68185461ff9644482244bf8d76fbe4d689b90635139e7eeb882102c6a',
  '021_data_store_natural_key': 'ce4c6061c7937bc7268709fe0e2368cb62fa7a4f57bd486e09d83cd858857d7d',
  '022_ds_column_format': 'baeb8f999fd83c1a8c5caf9c4dd03ecec53a6dec973a4b877981ad209a5ae438',
  '023_session_seeded_prompt': '0b4155ba2d4336ab0545caa85de96e1beaefef856a807483efab9a154969f8c8',
  '024_project_post_create_hook': 'd53012513f6587da0e7bd12a2ead5138c32c5224eb0d8fd4a89d26c3b1062a0a',
  '025_knowledge': '7a980446b193aadbc1077307e97cfc84cf1c2406b62d2399a8b23f0ceda3d144',
  '026_knowledge_import_provenance': '0c53b3aeac0dc08772ba664553046c5ed420b46d60ed80b0b347cabdb8d12d91',
  '027_manager_links': 'f9fd944ea174599d703f8f722f925d7ce97c8693ff837b1b635b20c2415ff24d',
  '028_manager_pulse_enabled': '17b74f8920fb0b5af90aab8dd996d9a437c2244c3984be1b27b6e321f0fcbac9',
  '029_governance_queue': '502a14be48995ce1947b9c48aee1cdd651c3b4902a718784fc42cda5c237b6c2',
  '030_denied_commands': '49a2833117da03c65dc71fe8effafaeb0a9bbad82895081bc23e97fbd5b1f914',
  '031_denial_read_cursors': 'd527bab337e294282942d66084bed6b5e7016e9d04d403c4d57dda4f4dc9bd46',
  '032_manager_base_read': '119945c3275b79b4b218938577ce7e89c528c833162be81396ecfd23dc2acff7',
  '033_review_findings': '391ac0ed280b31d448c4b0f69f4320b184e7e0a218ae38c54a170d67889ce5b9',
  '034_review_step_skips': '2dafa3c4cebabf34e8d096b3d025c7f282fc7e56d53e06bca472668ab6dc172d',
  '035_manager_profile': 'd90c5269005ac81b1434bf09c704b03befe60e88928df56052f61f383b71a4bb',
  '036_governance_laws': '5cb9c76d0c4968c782e1107ed35187b1590c34ee408d36b7eac567f983359a6d',
  '037_governance_waiting_proposals': '75335004d1343e74c83b8b1c1afa49c2e40544fa986230421988041feb93988f',
  '038_manager_note_read': '906af8b1fc413f53e73943ffa879d32775806f89f3b3757fcffc02bc8c6a398a',
  '039_session_effort': '56781a9926f0d6cdb33b75cdaf31631fc91e5268aef1967cb9fb757d9e0f22ca',
  '040_review_step_skip_provenance': '32b09fa05c5eb7c655fcac441184c7b8a1d5a87e65b4739b2726afbeb4f02e35',
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
