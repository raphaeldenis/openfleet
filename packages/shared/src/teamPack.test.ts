import { describe, expect, it } from 'vitest';
import { RoleBriefFrontMatterSchema, TEAM_ITEM_KINDS, TeamLawSchema, TeamPackManifestSchema, TeamPermissionProfileSchema, TeamProfileSchema } from './teamPack.js';

const SHA256 = 'a'.repeat(64);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);

const validManifest = () => ({
  packId: 'openfleet-default',
  version: '1.0.0',
  schema: 1,
  minDaemon: '0.0.0',
  items: [
    { key: 'role.dev', kind: 'role-brief', file: 'roles/dev.md', sha256: SHA256, editable: true, seedDefault: true },
    { key: 'doc.house-rules', kind: 'document', file: 'documents/house-rules.md', sha256: SHA256, editable: true, seedDefault: true, shareAcrossProjects: true },
    { key: 'profile.dev', kind: 'profile', file: 'profiles.json#dev', sha256: SHA256 },
    { key: 'perm.worker', kind: 'permission-profile', file: 'permissions/worker.json', sha256: SHA256 },
  ],
});

const validProfile = () => ({
  key: 'dev',
  role: 'dev',
  title: 'DEV',
  harness: 'claude-cli',
  model: 'sonnet',
  escalationRung: 'opus',
  allowedRungs: ['sonnet', 'opus'],
  permissionMode: 'manual',
  permissionProfile: 'worker',
  briefKey: 'role.dev',
  requires: ['doc.project-note', 'doc.house-rules', 'doc.definition-of-done'],
  canSpawn: false,
});

const validPermissionProfile = () => ({
  id: 'worker',
  description: 'Implementer or tester in its own worktree',
  mode: 'manual',
  rules: [
    { match: 'Read', decision: 'allow' },
    { match: 'Write', decision: 'allow', paths: { within: ['{{session.directory}}'], deny: ['.env*'] } },
    { match: 'Bash(git push --force*)', decision: 'deny', why: 'Shared history is never rewritten.' },
    { match: 'Bash(rm *)', decision: 'gate', why: 'Deletions need a human.' },
  ],
  default: 'gate',
});

const validLaw = () => ({
  id: 'worktree-base-fetched',
  legacyId: '63AD34FC',
  short: 'Fetch main and compare shas before every create_worktree.',
  rationale: 'A stale local main produced a worktree on old code.',
  enforcement: 'daemon',
  enforcedBy: 'create_worktree base_ref',
  status: 'active',
});

describe('the pack manifest', () => {
  it('accepts a manifest with every kind of entry', () => {
    expect(TeamPackManifestSchema.safeParse(validManifest()).success).toBe(true);
  });

  it('knows the nine item kinds', () => {
    expect(TEAM_ITEM_KINDS).toEqual(['role-brief', 'document', 'law', 'report-format', 'store-schema', 'profile', 'permission-profile', 'setting-defaults', 'persona-pool']);
  });

  it('rejects a field the schema does not know', () => {
    expect(TeamPackManifestSchema.safeParse({ ...validManifest(), extends: 'other-pack' }).success).toBe(false);
  });

  it('rejects an item kind outside the nine', () => {
    const manifest = validManifest();
    manifest.items[0] = { ...manifest.items[0]!, kind: 'script' };

    expect(TeamPackManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it.each(['../../etc/passwd', '/etc/passwd', 'roles/../../x.md', 'roles\\dev.md', '', 'roles//dev.md'])('rejects the file path %j', (file) => {
    const manifest = validManifest();
    manifest.items[0] = { ...manifest.items[0]!, file };

    expect(TeamPackManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('rejects a hash that is not sha256 hex', () => {
    const manifest = validManifest();
    manifest.items[0] = { ...manifest.items[0]!, sha256: 'xyz' };

    expect(TeamPackManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('rejects a version that is not semver', () => {
    expect(TeamPackManifestSchema.safeParse({ ...validManifest(), version: 'one' }).success).toBe(false);
  });

  it('rejects two items with the same key', () => {
    const manifest = validManifest();
    manifest.items.push({ ...manifest.items[0]!, file: 'roles/other.md' });

    expect(TeamPackManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('defaults the flags of an entry to false', () => {
    const parsed = TeamPackManifestSchema.parse(validManifest());

    expect(parsed.items[2]).toMatchObject({ editable: false, seedDefault: false, shareAcrossProjects: false });
  });
});

describe('the role brief front matter', () => {
  it('accepts a role, a title and the keys the brief reads', () => {
    const parsed = RoleBriefFrontMatterSchema.safeParse({ role: 'dev', title: 'Brief DEV', requires: ['doc.house-rules'] });

    expect(parsed.success).toBe(true);
  });

  it('trims the title', () => {
    expect(RoleBriefFrontMatterSchema.parse({ role: 'dev', title: '  Brief DEV  ' }).title).toBe('Brief DEV');
  });

  it('rejects a title made only of spaces', () => {
    expect(RoleBriefFrontMatterSchema.safeParse({ role: 'dev', title: '   ' }).success).toBe(false);
  });

  it('rejects a requires entry that is not an item key', () => {
    expect(RoleBriefFrontMatterSchema.safeParse({ role: 'dev', title: 'Brief DEV', requires: ['House rules'] }).success).toBe(false);
  });
});

describe('a team profile', () => {
  it('accepts a worker profile', () => {
    expect(TeamProfileSchema.safeParse(validProfile()).success).toBe(true);
  });

  it('accepts a manager profile with its spawn rights', () => {
    const lead = { ...validProfile(), key: 'lead', role: 'manager', canSpawn: true, maxChildren: 3, pulseSeconds: 1800, spawnableRoles: ['dev', 'qe'], lowTrustRoles: ['adversarial-reviewer'], exposedResources: ['verify'] };

    expect(TeamProfileSchema.safeParse(lead).success).toBe(true);
  });

  it('rejects a model name instead of a rung', () => {
    expect(TeamProfileSchema.safeParse({ ...validProfile(), model: 'claude-sonnet-5-5' }).success).toBe(false);
  });

  it('rejects a default rung outside the allowed rungs', () => {
    expect(TeamProfileSchema.safeParse({ ...validProfile(), model: 'haiku' }).success).toBe(false);
  });

  it('rejects an escalation rung outside the allowed rungs', () => {
    expect(TeamProfileSchema.safeParse({ ...validProfile(), escalationRung: 'fable' }).success).toBe(false);
  });

  it('rejects an unknown harness and an unknown permission mode', () => {
    expect(TeamProfileSchema.safeParse({ ...validProfile(), harness: 'codex' }).success).toBe(false);
    expect(TeamProfileSchema.safeParse({ ...validProfile(), permissionMode: 'yolo' }).success).toBe(false);
  });

  it('rejects a children cap beyond 64', () => {
    expect(TeamProfileSchema.safeParse({ ...validProfile(), canSpawn: true, maxChildren: 65 }).success).toBe(false);
  });

  it('rejects a spawn count on a profile that cannot spawn', () => {
    expect(TeamProfileSchema.safeParse({ ...validProfile(), canSpawn: false, maxChildren: 3 }).success).toBe(false);
  });

  it('rejects a field the schema does not know', () => {
    expect(TeamProfileSchema.safeParse({ ...validProfile(), bypass: true }).success).toBe(false);
  });
});

describe('a permission profile', () => {
  it('accepts the worker profile of the design', () => {
    expect(TeamPermissionProfileSchema.safeParse(validPermissionProfile()).success).toBe(true);
  });

  it('rejects a gate rule without a reason', () => {
    const profile = validPermissionProfile();
    profile.rules[3] = { match: 'Bash(rm *)', decision: 'gate' } as (typeof profile.rules)[number];

    expect(TeamPermissionProfileSchema.safeParse(profile).success).toBe(false);
  });

  it('rejects a deny rule without a reason', () => {
    const profile = validPermissionProfile();
    profile.rules[2] = { match: 'Bash(git push --force*)', decision: 'deny' } as (typeof profile.rules)[number];

    expect(TeamPermissionProfileSchema.safeParse(profile).success).toBe(false);
  });

  it('rejects a decision outside allow, gate and deny', () => {
    const profile = { ...validPermissionProfile(), default: 'ask' };

    expect(TeamPermissionProfileSchema.safeParse(profile).success).toBe(false);
  });

  it('requires a default decision', () => {
    const { default: _default, ...withoutDefault } = validPermissionProfile();

    expect(TeamPermissionProfileSchema.safeParse(withoutDefault).success).toBe(false);
  });

  it('trims the description and the rule texts', () => {
    const profile = validPermissionProfile();
    profile.rules[3] = { match: ' Bash(rm *) ', decision: 'gate', why: ' Deletions need a human. ' } as (typeof profile.rules)[number];

    const parsed = TeamPermissionProfileSchema.parse({ ...profile, description: '  Worker  ' });

    expect(parsed.description).toBe('Worker');
    expect(parsed.rules[3]).toMatchObject({ match: 'Bash(rm *)', why: 'Deletions need a human.' });
  });

  it('rejects a rule pattern made only of spaces', () => {
    const profile = validPermissionProfile();
    profile.rules[0] = { match: '   ', decision: 'allow' } as (typeof profile.rules)[number];

    expect(TeamPermissionProfileSchema.safeParse(profile).success).toBe(false);
  });

  it('rejects an empty rule pattern', () => {
    const profile = validPermissionProfile();
    profile.rules[0] = { match: '', decision: 'allow' } as (typeof profile.rules)[number];

    expect(TeamPermissionProfileSchema.safeParse(profile).success).toBe(false);
  });

  it('rejects a field the schema does not know', () => {
    const profile = { ...validPermissionProfile(), rules: [{ match: 'Read', decision: 'allow', regex: true }] };

    expect(TeamPermissionProfileSchema.safeParse(profile).success).toBe(false);
  });
});

describe('a law', () => {
  it('accepts a law enforced by the daemon', () => {
    expect(TeamLawSchema.safeParse(validLaw()).success).toBe(true);
  });

  it('accepts an advice law without enforcedBy', () => {
    const { enforcedBy: _enforcedBy, ...advice } = validLaw();

    expect(TeamLawSchema.safeParse({ ...advice, enforcement: 'advice' }).success).toBe(true);
  });

  it('rejects an enforced law that names no enforcer', () => {
    const { enforcedBy: _enforcedBy, ...withoutEnforcer } = validLaw();

    expect(TeamLawSchema.safeParse(withoutEnforcer).success).toBe(false);
  });

  it('rejects a short that spans several lines', () => {
    expect(TeamLawSchema.safeParse({ ...validLaw(), short: 'first\nsecond' }).success).toBe(false);
  });

  it.each([
    ['a carriage return', 'first\rsecond'],
    ['a line separator', `first${LINE_SEPARATOR}second`],
    ['a paragraph separator', `first${PARAGRAPH_SEPARATOR}second`],
  ])('rejects a short that contains %s', (_name, short) => {
    expect(TeamLawSchema.safeParse({ ...validLaw(), short }).success).toBe(false);
  });

  it('trims the free text of a law', () => {
    const parsed = TeamLawSchema.parse({ ...validLaw(), short: '  one line  ', rationale: '\n why \n', enforcedBy: ' daemon ' });

    expect(parsed).toMatchObject({ short: 'one line', rationale: 'why', enforcedBy: 'daemon' });
  });

  it('rejects a short made only of spaces', () => {
    expect(TeamLawSchema.safeParse({ ...validLaw(), short: '   ' }).success).toBe(false);
  });

  it('rejects an enforcement outside the three kinds', () => {
    expect(TeamLawSchema.safeParse({ ...validLaw(), enforcement: 'hope' }).success).toBe(false);
  });

  it('rejects a field the schema does not know', () => {
    expect(TeamLawSchema.safeParse({ ...validLaw(), severity: 'high' }).success).toBe(false);
  });
});
