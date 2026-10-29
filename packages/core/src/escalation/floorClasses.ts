import { ESCALATING_CLASSES, type EscalatingClass, type ExtraRule } from '@openfleet/shared';

export interface FloorInput {
  text: string;
  options?: readonly string[];
  recommendation?: string;
  paths?: readonly string[];
}

interface FloorRule {
  escalatingClass: EscalatingClass;
  pathGlobs: readonly string[];
  keywords: readonly string[];
}

const BUILT_IN_RULES: readonly FloorRule[] = [
  {
    escalatingClass: 'contract',
    pathGlobs: ['packages/shared/src/mcpContract.ts', '**/contract.pinned.json', '**/db/migrations/**', 'docs/mcp-contract.md', 'docs/errors.md', '**/api/**Routes.ts'],
    keywords: ['contract_version', 'migration', 'breaking change', 'public api', "schéma d'api", "nouveau code d'erreur"],
  },
  {
    escalatingClass: 'security',
    pathGlobs: ['**/policy/**', '**/redact*', '**/auth/**', '**/*token*', '**/harness/**/*Hooks.ts'],
    keywords: ['secret', 'token', 'credential', 'permission', 'sandbox', 'redaction', 'injection', 'authentification'],
  },
  {
    escalatingClass: 'deployment',
    pathGlobs: ['.github/workflows/**', '**/Dockerfile*', '**/tauri.conf.json', 'scripts/release*'],
    keywords: ['deploy', 'release', 'device', 'install', 'signing', 'appareil'],
  },
  { escalatingClass: 'history_rewrite', pathGlobs: [], keywords: ['force-push', 'rebase', 'filter-branch', 'reset --hard', 'amend', "réécriture d'historique"] },
  { escalatingClass: 'dod_waiver', pathGlobs: [], keywords: ['waive', 'waiver', 'skip qa', 'skip the test', 'without qa', 'dérogation', 'ignore the criterion'] },
  { escalatingClass: 'spend', pathGlobs: [], keywords: ['budget', 'billing', 'paid plan', 'purchase', 'subscription', 'dépense', 'coût'] },
  { escalatingClass: 'visual_qa', pathGlobs: [], keywords: ['visual qa', 'human qa', 'pixel', 'design review', 'qa visuelle'] },
];

const ANY_WHITESPACE = /\s+/gu;
const CONTROL_AND_FORMAT_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

/** Whitespace becomes one space; control, zero-width and bidi characters disappear; the rest is composed unicode in lower case. */
const comparable = (text: string): string =>
  text.replace(ANY_WHITESPACE, ' ').replace(CONTROL_AND_FORMAT_CHARACTERS, '').normalize('NFC').toLowerCase().trim();

const segmentsOfPath = (path: string): string[] =>
  comparable(path).replaceAll('\\', '/').split('/').filter((segment) => segment !== '' && segment !== '.');

const asRule = ({ class: escalatingClass, pathGlob, keyword }: ExtraRule): FloorRule => ({
  escalatingClass,
  pathGlobs: pathGlob === undefined ? [] : [pathGlob],
  keywords: keyword === undefined ? [] : [keyword],
});

/** A `*` stands for any run of characters inside the segment; the other characters stand for themselves. */
function matchesSegment(patternSegment: string, segment: string): boolean {
  let patternIndex = 0;
  let segmentIndex = 0;
  let starPatternIndex = -1;
  let starSegmentIndex = 0;
  while (segmentIndex < segment.length) {
    const isLiteralMatch = patternIndex < patternSegment.length && patternSegment[patternIndex] !== '*' && patternSegment[patternIndex] === segment[segmentIndex];
    if (isLiteralMatch) {
      patternIndex++;
      segmentIndex++;
    } else if (patternSegment[patternIndex] === '*') {
      starPatternIndex = patternIndex++;
      starSegmentIndex = segmentIndex;
    } else if (starPatternIndex !== -1) {
      patternIndex = starPatternIndex + 1;
      segmentIndex = ++starSegmentIndex;
    } else {
      return false;
    }
  }
  return patternSegment.slice(patternIndex).replaceAll('*', '') === '';
}

/** A `**` segment stands for zero or more path segments. The table is filled bottom-up, so the cost stays the product of the two lengths. */
function matchesPath(globSegments: readonly string[], pathSegments: readonly string[]): boolean {
  let below = Array.from({ length: pathSegments.length + 1 }, (_, pathIndex) => pathIndex === pathSegments.length);
  for (let globIndex = globSegments.length - 1; globIndex >= 0; globIndex--) {
    const globSegment = globSegments[globIndex]!;
    const isAnyDepth = globSegment === '**';
    const current = new Array<boolean>(pathSegments.length + 1).fill(false);
    current[pathSegments.length] = isAnyDepth && below[pathSegments.length]!;
    for (let pathIndex = pathSegments.length - 1; pathIndex >= 0; pathIndex--) {
      current[pathIndex] = isAnyDepth
        ? below[pathIndex]! || current[pathIndex + 1]!
        : matchesSegment(globSegment, pathSegments[pathIndex]!) && below[pathIndex + 1]!;
    }
    below = current;
  }
  return below[0]!;
}

const mentionsKeyword = (fields: readonly string[], keyword: string): boolean => {
  const comparableKeyword = comparable(keyword);
  return fields.some((field) => field.includes(comparableKeyword));
};

/**
 * Returns the escalating classes that the text, the options, the recommendation and the paths of a question put in its floor,
 * in the order of the vocabulary. The floor is a heuristic on keywords and paths: it only ever adds classes.
 */
export function computeFloorClasses(input: FloorInput, extraRules: readonly ExtraRule[] = []): EscalatingClass[] {
  const rules = [...BUILT_IN_RULES, ...extraRules.map(asRule)];
  const paths = input.paths ?? [];
  const fields = [input.text, ...(input.options ?? []), ...(input.recommendation === undefined ? [] : [input.recommendation]), ...paths].map(comparable);
  const pathsAsSegments = paths.map(segmentsOfPath);

  const isInFloor = (rule: FloorRule): boolean => {
    const isKeywordMentioned = rule.keywords.some((keyword) => mentionsKeyword(fields, keyword));
    if (isKeywordMentioned) return true;
    const globsAsSegments = rule.pathGlobs.map(segmentsOfPath);
    return globsAsSegments.some((globSegments) => pathsAsSegments.some((pathSegments) => matchesPath(globSegments, pathSegments)));
  };

  const classesInFloor = new Set(rules.filter(isInFloor).map((rule) => rule.escalatingClass));
  return ESCALATING_CLASSES.filter((escalatingClass) => classesInFloor.has(escalatingClass));
}
