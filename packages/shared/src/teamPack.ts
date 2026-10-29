import * as z from 'zod';
import { MAX_CHILDREN_CAP } from './managers.js';
import { HARNESSES, PERMISSION_MODES } from './session.js';

const SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;
const ITEM_KEY_PATTERN = /^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** A relative path of plain segments, optionally followed by `#fragment`: no `..`, no leading slash, no backslash, no empty segment. */
const PACK_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*(?:#[A-Za-z0-9_-]+)?$/;
const LAW_LEGACY_ID_PATTERN = /^[A-Za-z0-9]{4,16}$/;
const LINE_BREAK = /[\r\n\p{Zl}\p{Zp}]/u;

const MAX_PACK_FILE_CHARS = 200;
const MAX_ONE_LINE_CHARS = 200;
const MAX_TEXT_CHARS = 1000;

const SlugSchema = z.string().max(64).regex(SLUG_PATTERN);
const ItemKeySchema = z.string().max(80).regex(ITEM_KEY_PATTERN);
const trimmedText = (maxChars: number) => z.string().trim().min(1).max(maxChars);
const oneLineText = () => trimmedText(MAX_ONE_LINE_CHARS);
const longText = () => trimmedText(MAX_TEXT_CHARS);

export const TEAM_ITEM_KINDS = ['role-brief', 'document', 'law', 'report-format', 'store-schema', 'profile', 'permission-profile', 'setting-defaults', 'persona-pool'] as const;
export type TeamItemKind = (typeof TEAM_ITEM_KINDS)[number];

export const TEAM_MODEL_RUNGS = ['haiku', 'sonnet', 'opus', 'fable'] as const;
export type TeamModelRung = (typeof TEAM_MODEL_RUNGS)[number];
const ModelRungSchema = z.enum(TEAM_MODEL_RUNGS);

export const TEAM_PERMISSION_DECISIONS = ['allow', 'gate', 'deny'] as const;
export type TeamPermissionDecision = (typeof TEAM_PERMISSION_DECISIONS)[number];
const PermissionDecisionSchema = z.enum(TEAM_PERMISSION_DECISIONS);

export const TEAM_LAW_ENFORCEMENTS = ['daemon', 'permission-profile', 'advice'] as const;
export type TeamLawEnforcement = (typeof TEAM_LAW_ENFORCEMENTS)[number];

// ---------------------------------------------------------------- manifest

export const TeamPackItemSchema = z.strictObject({
  key: ItemKeySchema,
  kind: z.enum(TEAM_ITEM_KINDS),
  file: z.string().max(MAX_PACK_FILE_CHARS).regex(PACK_FILE_PATTERN),
  sha256: z.string().regex(SHA256_PATTERN),
  editable: z.boolean().default(false),
  seedDefault: z.boolean().default(false),
  shareAcrossProjects: z.boolean().default(false),
});
export type TeamPackItem = z.infer<typeof TeamPackItemSchema>;

export const TeamPackManifestSchema = z
  .strictObject({
    packId: SlugSchema,
    version: z.string().regex(SEMVER_PATTERN),
    schema: z.number().int().min(1),
    minDaemon: z.string().regex(SEMVER_PATTERN),
    items: z.array(TeamPackItemSchema),
  })
  .superRefine((manifest, context) => {
    const seenKeys = new Set<string>();
    manifest.items.forEach((item, index) => {
      const isDuplicate = seenKeys.has(item.key);
      seenKeys.add(item.key);
      if (isDuplicate) context.addIssue({ code: 'custom', path: ['items', index, 'key'], message: `duplicate item key ${item.key}` });
    });
  });
export type TeamPackManifest = z.infer<typeof TeamPackManifestSchema>;

export const RoleBriefFrontMatterSchema = z.strictObject({
  role: SlugSchema,
  title: oneLineText(),
  requires: z.array(ItemKeySchema).default([]),
});
export type RoleBriefFrontMatter = z.infer<typeof RoleBriefFrontMatterSchema>;

// ----------------------------------------------------------------- profile

export const TeamProfileSchema = z
  .strictObject({
    key: SlugSchema,
    role: SlugSchema,
    title: oneLineText().optional(),
    harness: z.enum(HARNESSES),
    model: ModelRungSchema,
    escalationRung: ModelRungSchema.optional(),
    allowedRungs: z.array(ModelRungSchema).min(1),
    permissionMode: z.enum(PERMISSION_MODES),
    permissionProfile: SlugSchema,
    briefKey: ItemKeySchema,
    requires: z.array(ItemKeySchema).default([]),
    canSpawn: z.boolean(),
    maxChildren: z.number().int().min(1).max(MAX_CHILDREN_CAP).optional(),
    pulseSeconds: z.number().int().min(1).max(86_400).optional(),
    spawnableRoles: z.array(SlugSchema).default([]),
    lowTrustRoles: z.array(SlugSchema).default([]),
    exposedResources: z.array(SlugSchema).default([]),
  })
  .superRefine((profile, context) => {
    const addIssue = (field: string, message: string) => context.addIssue({ code: 'custom', path: [field], message });
    if (!profile.allowedRungs.includes(profile.model)) addIssue('model', 'model must be one of allowedRungs');
    const escalationIsAllowed = profile.escalationRung === undefined || profile.allowedRungs.includes(profile.escalationRung);
    if (!escalationIsAllowed) addIssue('escalationRung', 'escalationRung must be one of allowedRungs');
    if (profile.canSpawn) return;
    const spawnFieldsSet = { maxChildren: profile.maxChildren !== undefined, pulseSeconds: profile.pulseSeconds !== undefined, spawnableRoles: profile.spawnableRoles.length > 0 };
    Object.entries(spawnFieldsSet).forEach(([field, isSet]) => isSet && addIssue(field, `${field} requires canSpawn`));
  });
export type TeamProfile = z.infer<typeof TeamProfileSchema>;

// ------------------------------------------------------ permission profile

const TeamPermissionRuleSchema = z
  .strictObject({
    match: oneLineText(),
    decision: PermissionDecisionSchema,
    why: longText().optional(),
    paths: z.strictObject({ within: z.array(oneLineText()).optional(), deny: z.array(oneLineText()).optional() }).optional(),
  })
  .refine((rule) => rule.decision === 'allow' || rule.why !== undefined, { message: 'a gate or deny rule explains itself with why', path: ['why'] });

export const TeamPermissionProfileSchema = z.strictObject({
  id: SlugSchema,
  description: longText(),
  mode: z.enum(PERMISSION_MODES),
  rules: z.array(TeamPermissionRuleSchema).max(200),
  default: PermissionDecisionSchema,
});
export type TeamPermissionProfile = z.infer<typeof TeamPermissionProfileSchema>;

// --------------------------------------------------------------------- law

export const TeamLawSchema = z
  .strictObject({
    id: SlugSchema,
    legacyId: z.string().regex(LAW_LEGACY_ID_PATTERN).optional(),
    short: oneLineText().refine((text) => !LINE_BREAK.test(text), { message: 'short is one line' }),
    rationale: longText(),
    enforcement: z.enum(TEAM_LAW_ENFORCEMENTS),
    enforcedBy: oneLineText().optional(),
    status: z.enum(['active']),
  })
  .refine((law) => law.enforcement === 'advice' || law.enforcedBy !== undefined, { message: 'an enforced law names its enforcer', path: ['enforcedBy'] });
export type TeamLaw = z.infer<typeof TeamLawSchema>;

// --------------------------------------------------------------- variables

const textVariables = <Key extends string>(...keys: Key[]) => z.strictObject(Object.fromEntries(keys.map((key) => [key, z.string()])) as Record<Key, z.ZodString>);

/** The catalogue of `{{namespace.key}}` variables: a template may use these and nothing else. */
export const TeamVariablesSchema = z.strictObject({
  project: textVariables('name', 'goal', 'repoPath', 'docsFolder', 'stack', 'defaultBranch'),
  commands: textVariables('install', 'build', 'test', 'dev', 'verify', 'lint', 'typecheck'),
  agent: textVariables('language', 'role', 'persona', 'emoji'),
  parent: textVariables('name'),
  models: textVariables('scout', 'worker', 'reviewer', 'escalation'),
  limits: textVariables('maxChildren', 'pulseMinutes'),
  paths: textVariables('evidenceDir', 'sandboxDir'),
  stores: textVariables('backlog', 'log', 'findings'),
});
export type TeamVariables = z.infer<typeof TeamVariablesSchema>;

export const TEAM_VARIABLE_NAMES: readonly string[] = Object.entries(TeamVariablesSchema.shape).flatMap(([namespace, namespaceSchema]) =>
  Object.keys(namespaceSchema.shape).map((key) => `${namespace}.${key}`),
);
const KNOWN_VARIABLE_NAMES: ReadonlySet<string> = new Set(TEAM_VARIABLE_NAMES);

// ------------------------------------------------------------------ render

export const MAX_TEMPLATE_VALUE_CHARS = 300;

const PLACEHOLDER_OPENING = '{{';
const PLACEHOLDER_CLOSING = '}}';
const ESCAPE_CHARACTER = '\\';
const PLACEHOLDER_NAME_PATTERN = /^[a-z][A-Za-z]*\.[A-Za-z]+$/;
const MAX_PLACEHOLDER_NAME_CHARS = 40;

const LINE_BREAKS_AND_TABS = /[\n\r\t\v\f\p{Zl}\p{Zp}]/gu;
const CONTROL_AND_FORMAT_CHARACTERS = /[\p{Cc}\p{Cf}\u{E0000}-\u{E007F}]/gu;
const ANY_BRACE = /[{}]/g;
const WHITESPACE_RUNS = /\s+/g;
const HIGH_SURROGATE_AT_END = /[\ud800-\udbff]$/;

export type TemplateRenderErrorCode = 'unknown_variable' | 'malformed_placeholder' | 'missing_value' | 'unused_variable';

export class TemplateRenderError extends Error {
  constructor(
    readonly code: TemplateRenderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TemplateRenderError';
  }
}

type TemplatePart = { text: string } | { variable: string };

const isVariablePart = (part: TemplatePart): part is { variable: string } => 'variable' in part;

/** Splits a template in one left-to-right pass; the values inserted later are never scanned again. */
function partsOf(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let cursor = 0;
  while (cursor < template.length) {
    const opening = template.indexOf(PLACEHOLDER_OPENING, cursor);
    if (opening === -1) {
      parts.push({ text: template.slice(cursor) });
      break;
    }
    const isEscaped = opening > cursor && template[opening - 1] === ESCAPE_CHARACTER;
    if (isEscaped) {
      parts.push({ text: template.slice(cursor, opening - 1) + PLACEHOLDER_OPENING });
      cursor = opening + PLACEHOLDER_OPENING.length;
      continue;
    }
    const nameStart = opening + PLACEHOLDER_OPENING.length;
    const closing = template.indexOf(PLACEHOLDER_CLOSING, nameStart);
    const isClosed = closing !== -1;
    const nameIsShortEnough = isClosed && closing - nameStart <= MAX_PLACEHOLDER_NAME_CHARS;
    const name = nameIsShortEnough ? template.slice(nameStart, closing) : '';
    if (!PLACEHOLDER_NAME_PATTERN.test(name)) throw new TemplateRenderError('malformed_placeholder', `malformed placeholder at offset ${opening}`);
    parts.push({ text: template.slice(cursor, opening) }, { variable: name });
    cursor = closing + PLACEHOLDER_CLOSING.length;
  }
  return parts;
}

function assertKnownVariable(name: string): void {
  if (!KNOWN_VARIABLE_NAMES.has(name)) throw new TemplateRenderError('unknown_variable', `unknown variable "${name}"`);
}

/** Turns an untrusted string into one plain line of at most MAX_TEMPLATE_VALUE_CHARS characters that holds no brace, so it can never form a placeholder. */
function toSafeLine(untrusted: string): string {
  const capped = untrusted
    .replace(LINE_BREAKS_AND_TABS, ' ')
    .replace(CONTROL_AND_FORMAT_CHARACTERS, '')
    .replace(ANY_BRACE, '')
    .replace(WHITESPACE_RUNS, ' ')
    .trim()
    .slice(0, MAX_TEMPLATE_VALUE_CHARS);
  return capped.replace(HIGH_SURROGATE_AT_END, '').trimEnd();
}

function valueOf(variables: TeamVariables, name: string): string {
  const [namespace = '', key = ''] = name.split('.');
  const value = (variables as Record<string, Record<string, unknown> | undefined>)[namespace]?.[key];
  if (typeof value !== 'string') throw new TemplateRenderError('missing_value', `no value for variable "${name}"`);
  return toSafeLine(value);
}

function renderParts(parts: readonly TemplatePart[], variables: TeamVariables): string {
  return parts
    .map((part) => {
      if (!isVariablePart(part)) return part.text;
      assertKnownVariable(part.variable);
      return valueOf(variables, part.variable);
    })
    .join('');
}

/** Returns the variable names a template references, in order of appearance. */
export function referencedVariables(template: string): string[] {
  const names = partsOf(template).filter(isVariablePart).map((part) => part.variable);
  names.forEach(assertKnownVariable);
  return names;
}

/** Renders `{{namespace.key}}` placeholders in one pure pass; a malformed or unknown placeholder throws a TemplateRenderError. */
export function renderTemplate(template: string, variables: TeamVariables): string {
  return renderParts(partsOf(template), variables);
}

/** Renders every template of a pack with one fixture and fails when a variable of the catalogue is used by none of them. */
export function renderTemplateSet(templates: Readonly<Record<string, string>>, variables: TeamVariables): Record<string, string> {
  const usedVariables = new Set<string>();
  const rendered = Object.fromEntries(
    Object.entries(templates).map(([templatePath, template]) => {
      try {
        const parts = partsOf(template);
        parts.filter(isVariablePart).forEach((part) => usedVariables.add(part.variable));
        return [templatePath, renderParts(parts, variables)];
      } catch (error) {
        if (!(error instanceof TemplateRenderError)) throw error;
        throw new TemplateRenderError(error.code, `${templatePath}: ${error.message}`);
      }
    }),
  );
  const unusedVariables = TEAM_VARIABLE_NAMES.filter((name) => !usedVariables.has(name));
  if (unusedVariables.length > 0) throw new TemplateRenderError('unused_variable', `variables used by no template: ${unusedVariables.join(', ')}`);
  return rendered;
}
