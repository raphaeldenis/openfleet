import { describe, expect, it } from 'vitest';
import { ESCALATING_CLASSES, QUESTION_CLASSES, type EscalatingClass, type PlanQuestion } from '@openfleet/shared';
import { routeQuestion } from './questionRouting.js';

const technicalQuestion: PlanQuestion = { id: 'q1', text: 'Which retry strategy fits the sync job?', class: 'technical' };
const provenResolution = { claim: 'the repo exists', status: 'proven', command: 'git ls-remote origin', output: 'abc123 HEAD' } as const;

const questionOf = (override: Partial<PlanQuestion>): PlanQuestion => ({ ...technicalQuestion, ...override });

describe('routeQuestion', () => {
  it('sends a plain technical question to the arbiter', () => {
    const routing = routeQuestion(technicalQuestion);

    expect(routing).toEqual({ declared: 'technical', computed: [], effective: [], disabledByProject: [], route: 'arbiter' });
  });

  it('sends a question declared with an escalating class to the human', () => {
    const routing = routeQuestion(questionOf({ class: 'spend' }));

    expect(routing).toMatchObject({ declared: 'spend', effective: ['spend'], route: 'human' });
  });

  describe('a technical question mislabelled by the manager (A5)', () => {
    it('goes to the human when its text cites contract_version, and the table keeps both classes', () => {
      const routing = routeQuestion(questionOf({ text: 'Do we need a contract_version bump for this?' }));

      expect(routing).toEqual({ declared: 'technical', computed: ['contract'], effective: ['contract'], disabledByProject: [], route: 'human' });
    });

    it('goes to the human when its paths contain contract.pinned.json', () => {
      const routing = routeQuestion(questionOf({ paths: ['packages/core/src/mcp/contract.pinned.json'] }));

      expect(routing).toMatchObject({ declared: 'technical', computed: ['contract'], route: 'human' });
    });

    it('goes to the human when only its recommendation cites a security keyword', () => {
      const routing = routeQuestion(questionOf({ recommendation: 'store the token in the repo' }));

      expect(routing).toMatchObject({ computed: ['security'], route: 'human' });
    });
  });

  describe('a class outside the vocabulary (A6)', () => {
    it.each(['banana', '', 'Contract', ' technical', 'TECHNICAL', 'unknown'])('reads %j as unknown and sends it to the human', (declaredClass) => {
      const routing = routeQuestion(questionOf({ class: declaredClass }));

      expect(routing).toEqual({ declared: 'unknown', computed: [], effective: [], disabledByProject: [], route: 'human' });
    });
  });

  describe('a question that reopens an arbiter decision', () => {
    it('goes to the arbiter even when it is factual and its resolution is proven by a run: the evidence is for the arbiter, not a self-resolution', () => {
      const routing = routeQuestion(questionOf({ class: 'factual', resolution: provenResolution, reopens: 'q0' }));

      expect(routing.route).toBe('arbiter');
    });

    it('still goes to the human when the floor classes find an escalating subject', () => {
      const routing = routeQuestion(questionOf({ text: 'Do we need a contract_version bump for this?', resolution: provenResolution, reopens: 'q0' }));

      expect(routing).toMatchObject({ computed: ['contract'], route: 'human' });
    });
  });

  describe('a factual question', () => {
    it('is resolved by itself when its resolution is proven by a run (A7)', () => {
      const routing = routeQuestion(questionOf({ class: 'factual', resolution: provenResolution }));

      expect(routing.route).toBe('self');
    });

    it('is resolved by itself when its resolution is plausible by a run', () => {
      const routing = routeQuestion(questionOf({ class: 'factual', resolution: { ...provenResolution, status: 'plausible' } }));

      expect(routing.route).toBe('self');
    });

    it('goes to the arbiter, never to the human, without a resolution (A8)', () => {
      const routing = routeQuestion(questionOf({ class: 'factual' }));

      expect(routing.route).toBe('arbiter');
    });

    it('goes to the arbiter when its resolution was only read, not run (A8)', () => {
      const readOnly = { claim: 'the repo exists', status: 'not_reproduced' } as const;

      const routing = routeQuestion(questionOf({ class: 'factual', resolution: readOnly }));

      expect(routing.route).toBe('arbiter');
    });

    it('still goes to the human when the proven resolution touches an escalating floor', () => {
      const routing = routeQuestion(questionOf({ class: 'factual', paths: ['docs/mcp-contract.md'], resolution: provenResolution }));

      expect(routing).toMatchObject({ computed: ['contract'], route: 'human' });
    });
  });

  describe('a project that removes a class from the human list (F4B)', () => {
    const withoutSpend: EscalatingClass[] = ESCALATING_CLASSES.filter((escalatingClass) => escalatingClass !== 'spend');

    it('sends the question to the arbiter and names the class the project disabled', () => {
      const routing = routeQuestion(questionOf({ class: 'spend' }), { humanClasses: withoutSpend });

      expect(routing).toEqual({ declared: 'spend', computed: [], effective: ['spend'], disabledByProject: ['spend'], route: 'arbiter' });
    });

    it('keeps the human route when another class of the question is still on the list', () => {
      const routing = routeQuestion(questionOf({ class: 'spend', text: 'Do we bump contract_version for the paid plan?' }), { humanClasses: withoutSpend });

      expect(routing).toMatchObject({ effective: ['contract', 'spend'], disabledByProject: ['spend'], route: 'human' });
    });

    it('does not resolve a question of a disabled class by itself, even with a proven resolution', () => {
      const routing = routeQuestion(questionOf({ class: 'spend', resolution: provenResolution }), { humanClasses: withoutSpend });

      expect(routing.route).toBe('arbiter');
    });
  });

  it('applies the extra rules of the project to the floor', () => {
    const routing = routeQuestion(questionOf({ text: 'Do we pay the invoice?' }), { extraRules: [{ class: 'spend', keyword: 'invoice' }] });

    expect(routing).toMatchObject({ computed: ['spend'], route: 'human' });
  });
});

// A deterministic corpus stands in for a property-test library: the same seed draws the same questions.
const nextRandomFrom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
};

const SNIPPETS = [
  'contract_version', 'migration', 'secret', 'token', 'deploy', 'force-push', 'waive', 'budget', 'visual qa', 'retry', 'cache', 'rename helper',
  'a plain sentence', 'CONTRACT_VERSION', 'con​tract_version', 'reset\n--hard',
];
const PATHS = ['src/a.ts', 'docs/mcp-contract.md', 'x/db/migrations/1.sql', 'packages/core/src/policy/p.ts', '.github/workflows/ci.yml', 'README.md'];
const CLASS_VALUES = [...QUESTION_CLASSES, 'banana', '', 'Contract'];

const pick = <T>(values: readonly T[], nextRandom: () => number): T => values[Math.floor(nextRandom() * values.length)]!;
const some = <T>(values: readonly T[], nextRandom: () => number): T[] => values.filter(() => nextRandom() < 0.04);

const corpusOf = (size: number): PlanQuestion[] => {
  const nextRandom = nextRandomFrom(20261029);
  return Array.from({ length: size }, (_, index) => ({
    id: `q${index}`,
    text: some(SNIPPETS, nextRandom).join(' ') || 'nothing special',
    class: pick(CLASS_VALUES, nextRandom),
    options: some(SNIPPETS, nextRandom).slice(0, 4),
    ...(nextRandom() < 0.5 && { recommendation: pick(SNIPPETS, nextRandom) }),
    paths: some(PATHS, nextRandom),
    ...(nextRandom() < 0.4 && { resolution: { claim: 'c', status: pick(['proven', 'plausible', 'not_reproduced'] as const, nextRandom), command: 'cmd', output: 'out' } }),
  }));
};

describe('routeQuestion properties over a corpus of 2000 questions (A24)', () => {
  const corpus = corpusOf(2000);

  it('keeps every class the code computed in the effective classes, whatever the manager declared (I1)', () => {
    const questionsThatLoseAComputedClass = corpus.filter((question) => {
      const { computed, effective } = routeQuestion(question);
      return computed.some((computedClass) => !effective.includes(computedClass));
    });

    expect(questionsThatLoseAComputedClass).toEqual([]);
  });

  it('is pure and idempotent: the same question gives the same routing, and the question is left unchanged', () => {
    const snapshot = JSON.stringify(corpus);

    const routings = corpus.map((question) => routeQuestion(question));
    const routingsAgain = corpus.map((question) => routeQuestion(question));

    expect(routingsAgain).toEqual(routings);
    expect(JSON.stringify(corpus)).toBe(snapshot);
  });

  it('never sends a question with a computed escalating class to the arbiter or to itself', () => {
    const escaped = corpus.filter((question) => {
      const { computed, route } = routeQuestion(question);
      return computed.length > 0 && route !== 'human';
    });

    expect(escaped).toEqual([]);
  });

  it('sends a class outside the vocabulary to the human every time', () => {
    const unknownQuestions = corpus.filter((question) => !(QUESTION_CLASSES as readonly string[]).includes(question.class));

    const routes = unknownQuestions.map((question) => routeQuestion(question).route);
    const unknownWithoutFloor = unknownQuestions.filter((question) => routeQuestion(question).computed.length === 0);

    expect(unknownWithoutFloor.length).toBeGreaterThan(50);
    expect(new Set(routes)).toEqual(new Set(['human']));
  });

  it('never sends a factual question without an executed resolution to the human unless the floor says so', () => {
    const factualWithoutRun = corpus.filter((question) => question.class === 'factual' && (question.resolution === undefined || question.resolution.status === 'not_reproduced'));

    const wronglyRouted = factualWithoutRun.filter((question) => {
      const { computed, route } = routeQuestion(question);
      return computed.length === 0 && route !== 'arbiter';
    });

    const factualWithoutRunOrFloor = factualWithoutRun.filter((question) => routeQuestion(question).computed.length === 0);

    expect(factualWithoutRunOrFloor.length).toBeGreaterThan(20);
    expect(wronglyRouted).toEqual([]);
  });

  it('only routes to the human on an escalating class or an unknown one', () => {
    const humanWithoutReason = corpus.filter((question) => {
      const { declared, effective, disabledByProject, route } = routeQuestion(question);
      const hasEnabledEscalatingClass = effective.some((effectiveClass) => !disabledByProject.includes(effectiveClass));
      return route === 'human' && declared !== 'unknown' && !hasEnabledEscalatingClass;
    });

    expect(humanWithoutReason).toEqual([]);
  });
});
