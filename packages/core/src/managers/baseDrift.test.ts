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

  describe('base_edited_without_bump', () => {
    it('reports a base whose sha differs from the sha released for its version', () => {
      const findings = checkBaseDrift({ base, releasedShas: { 3: 'sha-released-v3' }, missions: [] });

      expect(findings).toEqual([{ kind: 'base_edited_without_bump', version: 3, releasedSha: 'sha-released-v3', actualSha: 'sha-v3' }]);
    });

    it('reports a version that no pin records', () => {
      const findings = checkBaseDrift({ base, releasedShas: { 2: 'sha-v2' }, missions: [] });

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

    it('scans a 64 KiB mission without a quadratic blow-up', () => {
      const hostile = `${'a. '.repeat(21_000)}${'!'.repeat(1_000)}`;
      const startedAt = performance.now();

      checkBaseDrift({ base, missions: [{ label: 'Alpha', text: hostile }] });

      expect(performance.now() - startedAt).toBeLessThan(500);
    });
  });
});
