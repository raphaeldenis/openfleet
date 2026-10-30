/** A normalized sentence shorter than this is too generic to count as a repeated rule. */
export const MIN_RULE_SENTENCE_LENGTH = 40;

const SENTENCE_SEPARATORS = /[.!?;\n]+/;
const NON_WORD_RUNS = /[^\p{L}\p{N}]+/gu;

export interface DriftBase {
  version: number;
  sha: string;
  body: string;
}

export interface DriftMission {
  label: string;
  text: string;
}

export type BaseDriftFinding =
  | { kind: 'base_edited_without_bump'; version: number; releasedSha: string; actualSha: string }
  | { kind: 'base_version_unpinned'; version: number; actualSha: string }
  | { kind: 'duplicated_rule'; mission: string; sentence: string };

const normalizedSentenceOf = (sentence: string): string => sentence.normalize('NFKC').toLowerCase().replace(NON_WORD_RUNS, ' ').trim();

const ruleSentencesOf = (text: string): { sentence: string; normalized: string }[] =>
  text
    .split(SENTENCE_SEPARATORS)
    .map((sentence) => ({ sentence: sentence.trim(), normalized: normalizedSentenceOf(sentence) }))
    .filter(({ normalized }) => normalized.length >= MIN_RULE_SENTENCE_LENGTH);

function pinFindingOf(base: DriftBase, releasedShas: Record<number, string>): BaseDriftFinding[] {
  const releasedSha = releasedShas[base.version];
  if (releasedSha === undefined) return [{ kind: 'base_version_unpinned', version: base.version, actualSha: base.sha }];
  const isBaseAsReleased = releasedSha === base.sha;
  if (isBaseAsReleased) return [];
  return [{ kind: 'base_edited_without_bump', version: base.version, releasedSha, actualSha: base.sha }];
}

function duplicatedRulesOf(baseRules: ReadonlySet<string>, mission: DriftMission): BaseDriftFinding[] {
  const alreadyReported = new Set<string>();
  const findings: BaseDriftFinding[] = [];
  for (const { sentence, normalized } of ruleSentencesOf(mission.text)) {
    const isRuleOfBase = baseRules.has(normalized);
    if (!isRuleOfBase || alreadyReported.has(normalized)) continue;
    alreadyReported.add(normalized);
    findings.push({ kind: 'duplicated_rule', mission: mission.label, sentence });
  }
  return findings;
}

/**
 * Compares the shipped base with the sha released for its version and with the rules each mission restates.
 * Without `releasedShas` the pin is not checked.
 */
export function checkBaseDrift({ base, releasedShas, missions }: { base: DriftBase; releasedShas?: Record<number, string>; missions: readonly DriftMission[] }): BaseDriftFinding[] {
  const pinFindings = releasedShas ? pinFindingOf(base, releasedShas) : [];
  const baseRules = new Set(ruleSentencesOf(base.body).map(({ normalized }) => normalized));
  const duplicateFindings = missions.flatMap((mission) => duplicatedRulesOf(baseRules, mission));
  return [...pinFindings, ...duplicateFindings];
}
