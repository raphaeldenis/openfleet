import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PolicyRequest } from '@openfleet/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMAND_POLICY } from './defaultCommandPolicy.js';
import { evaluateCommandPolicy } from './policyEvaluator.js';
import { policyRequest } from './policyRequest.testkit.js';

type Family = 'FIX60' | 'FIX73';
interface PortedCase { id: string; python: string; request: Partial<PolicyRequest>; expect: 'allow' | 'deny'; ruleId?: string }
interface CaseFile {
  families: Record<Family, { expectedCaseCount: number; request: Partial<PolicyRequest>; denyRuleId?: string }>;
  cases: PortedCase[];
}

const CASE_FILE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'cases', 'ported-from-python.json');
const caseFile = JSON.parse(readFileSync(CASE_FILE_PATH, 'utf8')) as CaseFile;
const EXPECTED_PORTED_CASE_COUNT = 69;

const familyOf = (portedCase: PortedCase): Family => portedCase.id.slice(0, 5) as Family;
const requestOf = (portedCase: PortedCase): PolicyRequest =>
  policyRequest({ ...caseFile.families[familyOf(portedCase)].request, ...portedCase.request });

describe('the cases ported from the Python guards', () => {
  it('holds exactly 69 distinct case ids', () => {
    const ids = caseFile.cases.map((portedCase) => portedCase.id);

    expect(ids).toHaveLength(EXPECTED_PORTED_CASE_COUNT);
    expect(new Set(ids).size).toBe(EXPECTED_PORTED_CASE_COUNT);
  });

  it.each(Object.entries({ FIX60: 27, FIX73: 42 }))('holds the %s cases of its Python test file (%i)', (family, count) => {
    const familyCases = caseFile.cases.filter((portedCase) => familyOf(portedCase) === family);

    expect(familyCases).toHaveLength(count);
    expect(caseFile.families[family as Family].expectedCaseCount).toBe(count);
  });

  it('numbers the cases of each family without a gap', () => {
    const expectedIds = [
      ...Array.from({ length: 27 }, (_, index) => `FIX60-${String(index + 1).padStart(2, '0')}`),
      ...Array.from({ length: 42 }, (_, index) => `FIX73-${String(index + 1).padStart(2, '0')}`),
    ];

    expect(caseFile.cases.map((portedCase) => portedCase.id)).toEqual(expectedIds);
  });

  it('points every case at one Python test', () => {
    expect(caseFile.cases.filter((portedCase) => !portedCase.python.startsWith('test_'))).toEqual([]);
  });

  describe.each(caseFile.cases.map((portedCase) => [portedCase.id, portedCase] as const))('%s', (_id, portedCase) => {
    it(`${portedCase.expect}s like the Python guard (${portedCase.python})`, () => {
      const verdict = evaluateCommandPolicy(requestOf(portedCase), DEFAULT_COMMAND_POLICY);

      expect(verdict.decision).toBe(portedCase.expect);
    });

    if (portedCase.expect === 'deny') {
      it('names the rule and explains how to continue', () => {
        const verdict = evaluateCommandPolicy(requestOf(portedCase), DEFAULT_COMMAND_POLICY);
        const expectedRuleId = portedCase.ruleId ?? caseFile.families[familyOf(portedCase)].denyRuleId;

        expect(verdict).toMatchObject({ decision: 'deny', ruleId: expectedRuleId, reason: expect.any(String), alternative: expect.any(String) });
      });
    }
  });
});
