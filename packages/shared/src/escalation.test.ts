import { describe, expect, it } from 'vitest';
import {
  ArbiterOpinionSchema, ESCALATING_CLASSES, EscalationPolicySchema, isEscalatingClass, isQuestionClass, PlanQuestionSchema, QUESTION_CLASSES,
  UNREMOVABLE_ESCALATING_CLASSES,
} from './escalation.js';

const minimalQuestion = { id: 'q1', text: 'Which retry strategy fits the sync job?', class: 'technical' };

const decision = { question_id: 'q1', verdict: 'decided', decision: 'Uses exponential backoff.', rationale: 'The job is idempotent.' };
const favourableOpinion = { batch_id: 'b1', decisions: [decision], criteria: { opinion: 'favourable', reasons: [] } };

describe('the question classes', () => {
  it('lists factual and technical as the classes that never reach a human, then the seven escalating ones', () => {
    expect(QUESTION_CLASSES).toEqual(['factual', 'technical', 'contract', 'security', 'deployment', 'history_rewrite', 'dod_waiver', 'spend', 'visual_qa']);
    expect(ESCALATING_CLASSES).toEqual(['contract', 'security', 'deployment', 'history_rewrite', 'dod_waiver', 'spend', 'visual_qa']);
  });

  it('tells an escalating class from the other classes and from a value outside the vocabulary', () => {
    expect(isEscalatingClass('contract')).toBe(true);
    expect(isEscalatingClass('technical')).toBe(false);
    expect(isEscalatingClass('banana')).toBe(false);
    expect(isQuestionClass('factual')).toBe(true);
    expect(isQuestionClass('banana')).toBe(false);
  });
});

describe('PlanQuestionSchema', () => {
  it('accepts a question reduced to its id, its text and its class', () => {
    expect(PlanQuestionSchema.safeParse(minimalQuestion).success).toBe(true);
  });

  it('accepts a class outside the vocabulary, which the router reads as unknown and sends to a human', () => {
    expect(PlanQuestionSchema.safeParse({ ...minimalQuestion, class: 'banana' }).success).toBe(true);
  });

  it.each([
    ['an empty id', { id: '' }],
    ['an id above 20 characters', { id: 'q'.repeat(21) }],
    ['a text above 300 characters', { text: 'x'.repeat(301) }],
    ['an empty text', { text: '' }],
    ['more than four options', { options: ['a', 'b', 'c', 'd', 'e'] }],
    ['a recommendation above 300 characters', { recommendation: 'x'.repeat(301) }],
    ['more than twenty paths', { paths: Array.from({ length: 21 }, (_, index) => `src/file${index}.ts`) }],
    ['a resolution that claims a run without its output', { resolution: { claim: 'the repo exists', status: 'proven', command: 'git ls-remote origin' } }],
  ])('refuses %s', (_label, override) => {
    expect(PlanQuestionSchema.safeParse({ ...minimalQuestion, ...override }).success).toBe(false);
  });

  it('accepts a resolution backed by the command and its output', () => {
    const resolution = { claim: 'the repo exists', status: 'proven', command: 'git ls-remote origin', output: 'abc123 HEAD' };

    expect(PlanQuestionSchema.safeParse({ ...minimalQuestion, class: 'factual', resolution }).success).toBe(true);
  });

  it('refuses a field it does not know', () => {
    expect(PlanQuestionSchema.safeParse({ ...minimalQuestion, priority: 'high' }).success).toBe(false);
  });

  it('accepts reopens, the id of the question whose arbiter decision the manager contests', () => {
    expect(PlanQuestionSchema.safeParse({ ...minimalQuestion, reopens: 'q0' }).success).toBe(true);
  });

  it.each([
    ['an empty reopens', ''],
    ['a reopens above 20 characters', 'q'.repeat(21)],
  ])('refuses %s', (_label, reopens) => {
    expect(PlanQuestionSchema.safeParse({ ...minimalQuestion, reopens }).success).toBe(false);
  });

  describe('identifiers', () => {
    const unsafeIdentifiers = [
      ['a newline', 'q\n1'],
      ['a carriage return', 'q\r1'],
      ['a line separator', `q${String.fromCharCode(0x2028)}1`],
      ['a paragraph separator', `q${String.fromCharCode(0x2029)}1`],
      ['a right-to-left override', `q${String.fromCharCode(0x202e)}1`],
      ['a zero-width space', `q${String.fromCharCode(0x200b)}1`],
      ['a control character', `q${String.fromCharCode(0x07)}1`],
      ['a space', 'q 1'],
      ['a bracket', '[esc:1]'],
    ] as const;

    it.each(['q1', 'Q-1', 'f_2', 'n1.2', 'a:b', 'CCM-123.q4'])('accepts the identifier %s for the id and for reopens', (identifier) => {
      expect(PlanQuestionSchema.safeParse({ ...minimalQuestion, id: identifier, reopens: identifier }).success).toBe(true);
    });

    it.each(unsafeIdentifiers)('refuses an id with %s', (_label, id) => {
      expect(PlanQuestionSchema.safeParse({ ...minimalQuestion, id }).success).toBe(false);
    });

    it.each(unsafeIdentifiers)('refuses a reopens with %s', (_label, reopens) => {
      expect(PlanQuestionSchema.safeParse({ ...minimalQuestion, reopens }).success).toBe(false);
    });

    it('refuses an unsafe id with a constant message that does not echo the value', () => {
      const id = `q${String.fromCharCode(0x2028)}ZZZ`;

      const result = PlanQuestionSchema.safeParse({ ...minimalQuestion, id });

      expect(JSON.stringify(result.error?.issues)).not.toContain('ZZZ');
    });
  });

  describe('class', () => {
    it('accepts a class of 64 characters and refuses one of 65', () => {
      expect(PlanQuestionSchema.safeParse({ ...minimalQuestion, class: 'c'.repeat(64) }).success).toBe(true);
      expect(PlanQuestionSchema.safeParse({ ...minimalQuestion, class: 'c'.repeat(65) }).success).toBe(false);
    });
  });
});

describe('ArbiterOpinionSchema', () => {
  it('accepts a favourable opinion that decides every question', () => {
    expect(ArbiterOpinionSchema.safeParse(favourableOpinion).success).toBe(true);
  });

  it('accepts a needs_human verdict that raises the question to an escalating class', () => {
    const raised = { ...decision, verdict: 'needs_human', raise_to: 'security' };

    expect(ArbiterOpinionSchema.safeParse({ ...favourableOpinion, decisions: [raised], criteria: { opinion: 'unfavourable', reasons: ['a security question is open'] } }).success).toBe(true);
  });

  it('refuses to raise a question to a class that is not escalating', () => {
    const raisedToTechnical = { ...decision, raise_to: 'technical' };

    expect(ArbiterOpinionSchema.safeParse({ ...favourableOpinion, decisions: [raisedToTechnical] }).success).toBe(false);
  });

  it('refuses two decisions on the same question', () => {
    expect(ArbiterOpinionSchema.safeParse({ ...favourableOpinion, decisions: [decision, decision] }).success).toBe(false);
  });

  it('refuses an unfavourable opinion that gives no reason', () => {
    expect(ArbiterOpinionSchema.safeParse({ ...favourableOpinion, criteria: { opinion: 'unfavourable', reasons: [] } }).success).toBe(false);
  });

  it('refuses an opinion without decision and one with more than twenty', () => {
    const twentyOneDecisions = Array.from({ length: 21 }, (_, index) => ({ ...decision, question_id: `q${index}` }));

    expect(ArbiterOpinionSchema.safeParse({ ...favourableOpinion, decisions: [] }).success).toBe(false);
    expect(ArbiterOpinionSchema.safeParse({ ...favourableOpinion, decisions: twentyOneDecisions }).success).toBe(false);
  });

  it.each([
    ['an empty decision', { decision: '' }],
    ['a rationale above 600 characters', { rationale: 'x'.repeat(601) }],
    ['an unknown verdict', { verdict: 'maybe' }],
  ])('refuses %s', (_label, override) => {
    expect(ArbiterOpinionSchema.safeParse({ ...favourableOpinion, decisions: [{ ...decision, ...override }] }).success).toBe(false);
  });
});

describe('EscalationPolicySchema', () => {
  it('fills the defaults of the design from an empty setting', () => {
    expect(EscalationPolicySchema.parse({})).toEqual({
      humanClasses: [...ESCALATING_CLASSES],
      extraRules: [],
      arbiterModel: 'opus',
      maxArbiterRunsPerTicket: 3,
      criteriaStatusColumn: 'criteria_status',
      approvedOption: 'approved',
      askUserGate: 'warn',
    });
  });

  it('lets a project remove an escalating class other than contract and security', () => {
    const withoutSpend = ESCALATING_CLASSES.filter((escalatingClass) => escalatingClass !== 'spend');

    expect(EscalationPolicySchema.safeParse({ humanClasses: withoutSpend }).success).toBe(true);
  });

  it('keeps only contract and security when a project removes every other class', () => {
    expect(EscalationPolicySchema.safeParse({ humanClasses: [...UNREMOVABLE_ESCALATING_CLASSES] }).success).toBe(true);
  });

  it.each(UNREMOVABLE_ESCALATING_CLASSES)('refuses a setting that removes %s, the floor that no project can lift', (unremovableClass) => {
    const withoutIt = ESCALATING_CLASSES.filter((escalatingClass) => escalatingClass !== unremovableClass);

    expect(EscalationPolicySchema.safeParse({ humanClasses: withoutIt }).success).toBe(false);
  });

  it('refuses an empty list of human classes', () => {
    expect(EscalationPolicySchema.safeParse({ humanClasses: [] }).success).toBe(false);
  });

  it('refuses a class outside the vocabulary in the human classes', () => {
    expect(EscalationPolicySchema.safeParse({ humanClasses: [...ESCALATING_CLASSES, 'technical'] }).success).toBe(false);
  });

  it('refuses a field it does not know', () => {
    expect(EscalationPolicySchema.safeParse({ arbiterBudget: 5 }).success).toBe(false);
  });

  it.each([
    ['an arbiter model below opus', { arbiterModel: 'haiku' }],
    ['no arbiter run per ticket', { maxArbiterRunsPerTicket: 0 }],
    ['more than ten arbiter runs per ticket', { maxArbiterRunsPerTicket: 11 }],
    ['a gate mode that does not exist', { askUserGate: 'block' }],
    ['an empty criteria column', { criteriaStatusColumn: '' }],
  ])('refuses %s', (_label, setting) => {
    expect(EscalationPolicySchema.safeParse(setting).success).toBe(false);
  });

  it('accepts an extra rule by path glob or by keyword and refuses one that has neither', () => {
    const byPath = { class: 'deployment', pathGlob: 'infra/**' };
    const byKeyword = { class: 'spend', keyword: 'invoice' };
    const withNeither = { class: 'spend' };

    expect(EscalationPolicySchema.safeParse({ extraRules: [byPath, byKeyword] }).success).toBe(true);
    expect(EscalationPolicySchema.safeParse({ extraRules: [withNeither] }).success).toBe(false);
  });

  it('refuses an extra rule on a class outside the escalating ones and more than forty rules', () => {
    const forty1Rules = Array.from({ length: 41 }, (_, index) => ({ class: 'spend', keyword: `word${index}` }));

    expect(EscalationPolicySchema.safeParse({ extraRules: [{ class: 'technical', keyword: 'x' }] }).success).toBe(false);
    expect(EscalationPolicySchema.safeParse({ extraRules: forty1Rules }).success).toBe(false);
  });
});
