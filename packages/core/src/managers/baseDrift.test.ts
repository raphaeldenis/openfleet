import { describe, expect, it } from 'vitest';
import { checkBaseDrift, MIN_RULE_SENTENCE_LENGTH } from './baseDrift.js';

const RULE = 'Never spawn a child before the plan questions are submitted to the arbiter.';
const RULE_WITHOUT_FINAL_DOT = RULE.slice(0, -1);
const base = { version: 3, sha: 'sha-v3', body: `## §1 Precedence [invariant]\n\n${RULE}\nA short line.` };
const pinnedAsShipped = { 3: 'sha-v3' };

describe('checkBaseDrift', () => {
  it('reports nothing for a base that matches its pin and a mission that restates no rule', () => {
    const findings = checkBaseDrift({ base, releasedShas: pinnedAsShipped, missions: [{ label: 'Alpha', text: 'Deliver the billing export for the finance team.' }] });

    expect(findings).toEqual([]);
  });

  describe('the pin', () => {
    it('reports a base whose sha differs from the sha released for its version', () => {
      const findings = checkBaseDrift({ base, releasedShas: { 3: 'sha-released-v3' }, missions: [] });

      expect(findings).toEqual([{ kind: 'base_edited_without_bump', version: 3, releasedSha: 'sha-released-v3', actualSha: 'sha-v3' }]);
    });

    it('reports a version that no pin records', () => {
      const findings = checkBaseDrift({ base, releasedShas: { 2: 'sha-v2' }, missions: [] });

      expect(findings).toEqual([{ kind: 'base_version_unpinned', version: 3, actualSha: 'sha-v3' }]);
    });

    it('reports every version as unpinned when the pin is empty', () => {
      const findings = checkBaseDrift({ base, releasedShas: {}, missions: [] });

      expect(findings).toEqual([{ kind: 'base_version_unpinned', version: 3, actualSha: 'sha-v3' }]);
    });

    it('does not check the pin when none is given', () => {
      expect(checkBaseDrift({ base, missions: [] })).toEqual([]);
    });
  });

  describe('duplicated_rule', () => {
    it('reports a mission sentence that repeats a rule of the base', () => {
      const findings = checkBaseDrift({ base, missions: [{ label: 'Alpha', text: `Context first. ${RULE} Then deliver.` }] });

      expect(findings).toEqual([{ kind: 'duplicated_rule', mission: 'Alpha', sentence: RULE_WITHOUT_FINAL_DOT }]);
    });

    it('ignores case, spacing and punctuation differences', () => {
      const reworded = '  NEVER  spawn a child, before the plan questions are submitted to the arbiter!! ';

      const findings = checkBaseDrift({ base, missions: [{ label: 'Alpha', text: reworded }] });

      expect(findings).toEqual([expect.objectContaining({ kind: 'duplicated_rule', mission: 'Alpha' })]);
    });

    it('ignores a repeated sentence shorter than the minimum length', () => {
      const shortRule = 'A short line.';
      expect(shortRule.length).toBeLessThan(MIN_RULE_SENTENCE_LENGTH);

      const findings = checkBaseDrift({ base, missions: [{ label: 'Alpha', text: shortRule }] });

      expect(findings).toEqual([]);
    });

    it('reports a sentence once per mission even when the mission repeats it', () => {
      const findings = checkBaseDrift({ base, missions: [{ label: 'Alpha', text: `${RULE}\n${RULE}` }] });

      expect(findings).toHaveLength(1);
    });

    it('labels each finding with the mission it comes from', () => {
      const findings = checkBaseDrift({ base, missions: [{ label: 'Alpha', text: RULE }, { label: 'Beta', text: 'Nothing shared here.' }, { label: 'Gamma', text: RULE }] });

      expect(findings).toEqual([
        { kind: 'duplicated_rule', mission: 'Alpha', sentence: RULE_WITHOUT_FINAL_DOT },
        { kind: 'duplicated_rule', mission: 'Gamma', sentence: RULE_WITHOUT_FINAL_DOT },
      ]);
    });

    it('reads list items of the base as sentences', () => {
      const listBase = { ...base, body: `- ${RULE}\n2. Keep the journal current with the log table at every step.` };

      const findings = checkBaseDrift({ base: listBase, missions: [{ label: 'Alpha', text: 'keep the journal current with the log table at every step' }] });

      expect(findings).toEqual([expect.objectContaining({ kind: 'duplicated_rule', mission: 'Alpha' })]);
    });

    it('reports a sentence of exactly the minimum length and ignores one character less', () => {
      const atMinimum = 'a'.repeat(MIN_RULE_SENTENCE_LENGTH);
      const belowMinimum = 'b'.repeat(MIN_RULE_SENTENCE_LENGTH - 1);
      const boundaryBase = { ...base, body: `${atMinimum}\n${belowMinimum}` };

      const findings = checkBaseDrift({ base: boundaryBase, missions: [{ label: 'Alpha', text: `${atMinimum}\n${belowMinimum}` }] });

      expect(findings).toEqual([{ kind: 'duplicated_rule', mission: 'Alpha', sentence: atMinimum }]);
    });

    it('treats a full-width rendering of a rule as the same rule', () => {
      const toFullWidth = (text: string) => [...text].map((character) => (character >= '!' && character <= '~' ? String.fromCharCode(character.charCodeAt(0) + 0xfee0) : character)).join('');

      const findings = checkBaseDrift({ base, missions: [{ label: 'Alpha', text: toFullWidth(RULE) }] });

      expect(findings).toEqual([expect.objectContaining({ kind: 'duplicated_rule', mission: 'Alpha' })]);
    });

    describe('on large inputs', () => {
      const SENTENCE_COUNT = 20_000;
      const LINEAR_TIME_BUDGET_MS = 1_000;
      const LONG_COMMON_PREFIX = 'every generated sentence starts with the same long prefix so that a comparison reads far before it differs'.repeat(2);
      const distinctSentences = (ownWord: string) => Array.from({ length: SENTENCE_COUNT }, (_, index) => `${LONG_COMMON_PREFIX} ${ownWord} ${String(index).padStart(6, '0')}`);

      it('looks up thousands of distinct sentences against a large base in linear time', () => {
        const largeBase = { ...base, body: distinctSentences('alpha').join('.\n') };
        const largeMission = { label: 'Alpha', text: distinctSentences('omega').join('.\n') };
        const startedAt = performance.now();

        const findings = checkBaseDrift({ base: largeBase, missions: [largeMission] });

        expect(findings).toEqual([]);
        expect(performance.now() - startedAt).toBeLessThan(LINEAR_TIME_BUDGET_MS);
      });

      it('scans a 64 KiB mission of thousands of distinct sentences against a large base in linear time', () => {
        const SIXTY_FOUR_KIB = 64 * 1024;
        const shortSentenceAt = (index: number) => `mission sentence number ${String(index).padStart(6, '0')} stays distinct`;
        const BASE_SENTENCE_COUNT = 200_000;
        const sameLengthSentenceOfBaseAt = (index: number) => shortSentenceAt(index).replace('distinct', 'distinkt');
        const baseSentences = Array.from({ length: BASE_SENTENCE_COUNT }, (_, index) => sameLengthSentenceOfBaseAt(index));
        const largeBase = { ...base, body: baseSentences.join('.\n') };
        const sentenceWithSeparatorLength = shortSentenceAt(0).length + '.\n'.length;
        const missionSentences = Array.from({ length: Math.ceil(SIXTY_FOUR_KIB / sentenceWithSeparatorLength) }, (_, index) => shortSentenceAt(index));
        const mission = { label: 'Alpha', text: missionSentences.join('.\n') };
        expect(missionSentences.length).toBeGreaterThan(1_000);
        expect(missionSentences.every((sentence) => sentence.length >= MIN_RULE_SENTENCE_LENGTH)).toBe(true);
        const startedAt = performance.now();

        const findings = checkBaseDrift({ base: largeBase, missions: [mission] });

        expect(findings).toEqual([]);
        expect(performance.now() - startedAt).toBeLessThan(LINEAR_TIME_BUDGET_MS);
      });
    });
  });
});
