import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { EscalationRepository, type NewQuestion } from './escalationRepository.js';

const MANAGER_ID = 'm1';
const TICKET = 'KB-01a';

let repository: EscalationRepository;

beforeEach(() => {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO sessions (id, name, directory, harness, state, state_since, hook_token, mcp_token, created_at) VALUES (?, 'Lead', '/tmp', 'fake', 'idle', 't', 'hook', 'mcp', 't')`).run(MANAGER_ID);
  db.prepare("INSERT INTO managers (session_id, pulse_seconds, children_cap, mission_text, created_at) VALUES (?, 3600, 2, 'Lead', 't')").run(MANAGER_ID);
  repository = new EscalationRepository(db);
});

const aBatch = (id = 'b1', ticket = TICKET) =>
  repository.insertBatch({ id, managerId: MANAGER_ID, ticket, planNoteId: 'n1', planNoteRev: 3, createdAt: 't0' });

const aQuestion = (override: Partial<NewQuestion> = {}): NewQuestion => ({
  batchId: 'b1', questionId: 'q1', text: 'Which retry strategy?', declaredClass: 'technical', computedClasses: [], effectiveClasses: [], route: 'arbiter', status: 'open', ...override,
});

describe('the batches', () => {
  it('reads back a batch with no arbiter run and no criteria opinion', () => {
    aBatch();

    expect(repository.findBatch('b1')).toEqual({ id: 'b1', managerId: MANAGER_ID, ticket: TICKET, planNoteId: 'n1', planNoteRev: 3, arbiterRuns: 0, createdAt: 't0' });
  });

  it('returns undefined for a batch that does not exist', () => {
    expect(repository.findBatch('nope')).toBeUndefined();
  });

  it('counts the arbiter runs of a ticket across its batches, and of no other ticket', () => {
    aBatch('b1');
    aBatch('b2');
    aBatch('b3', 'KB-02');

    repository.addArbiterRun('b1');
    repository.addArbiterRun('b2');
    repository.addArbiterRun('b2');
    repository.addArbiterRun('b3');

    expect(repository.arbiterRunsOfTicket({ managerId: MANAGER_ID, ticket: TICKET })).toBe(3);
    expect(repository.arbiterRunsOfTicket({ managerId: MANAGER_ID, ticket: 'KB-02' })).toBe(1);
    expect(repository.arbiterRunsOfTicket({ managerId: MANAGER_ID, ticket: 'KB-99' })).toBe(0);
  });

  it('keeps the criteria opinion of the arbiter with its reasons', () => {
    aBatch();

    repository.recordCriteriaOpinion({ batchId: 'b1', opinion: 'unfavourable', reasons: ['a security question is open'] });

    expect(repository.findBatch('b1')).toMatchObject({ criteriaOpinion: { opinion: 'unfavourable', reasons: ['a security question is open'] } });
  });
});

describe('the questions', () => {
  beforeEach(() => aBatch());

  it('reads back a question with everything the router decided, in the order of insertion', () => {
    repository.insertQuestion(aQuestion({
      questionId: 'q1', declaredClass: 'technical', computedClasses: ['contract'], effectiveClasses: ['contract'], route: 'human', status: 'pending_human',
      options: ['a', 'b'], recommendation: 'a', paths: ['docs/mcp-contract.md'],
    }));
    repository.insertQuestion(aQuestion({ questionId: 'q2', declaredClass: 'banana', route: 'human', status: 'pending_human' }));

    const [first, second] = repository.questionsOfBatch('b1');

    expect(first).toEqual({
      batchId: 'b1', questionId: 'q1', text: 'Which retry strategy?', declaredClass: 'technical', computedClasses: ['contract'], effectiveClasses: ['contract'],
      route: 'human', status: 'pending_human', options: ['a', 'b'], recommendation: 'a', paths: ['docs/mcp-contract.md'],
    });
    expect(second).toMatchObject({ questionId: 'q2', declaredClass: 'banana' });
  });

  it('keeps the proven resolution of a factual question', () => {
    const resolution = { claim: 'the repo exists', status: 'proven', command: 'git ls-remote origin', output: 'abc123 HEAD' } as const;

    repository.insertQuestion(aQuestion({ declaredClass: 'factual', route: 'self', status: 'self_resolved', resolution }));

    expect(repository.questionsOfBatch('b1')[0]).toMatchObject({ resolution });
  });

  it('refuses the same question id twice in a batch', () => {
    repository.insertQuestion(aQuestion());

    expect(() => repository.insertQuestion(aQuestion())).toThrow();
  });

  describe('moving a question from one status to the next', () => {
    it('moves an open question and records the reason', () => {
      repository.insertQuestion(aQuestion());

      const moved = repository.transitionQuestion({ batchId: 'b1', questionId: 'q1', from: 'open', to: 'pending_human', reason: 'arbiter_unavailable' });

      expect(moved).toBe(true);
      expect(repository.questionsOfBatch('b1')[0]).toMatchObject({ status: 'pending_human', reason: 'arbiter_unavailable' });
    });

    it('does nothing to a question that is no longer in the status the caller expects, and says so', () => {
      repository.insertQuestion(aQuestion({ status: 'answered' }));

      const moved = repository.transitionQuestion({ batchId: 'b1', questionId: 'q1', from: 'open', to: 'decided' });

      expect(moved).toBe(false);
      expect(repository.questionsOfBatch('b1')[0]!.status).toBe('answered');
    });

    it('stores the human answer with the move to answered', () => {
      repository.insertQuestion(aQuestion({ route: 'human', status: 'pending_human' }));

      repository.transitionQuestion({ batchId: 'b1', questionId: 'q1', from: 'pending_human', to: 'answered', humanAnswer: 'Use backoff.', answeredAt: 't5' });

      expect(repository.questionsOfBatch('b1')[0]).toMatchObject({ status: 'answered', humanAnswer: 'Use backoff.', answeredAt: 't5' });
    });
  });
});

describe('the escalations', () => {
  beforeEach(() => aBatch());

  const anEscalation = (id: string, ticket = TICKET) => ({ id, managerId: MANAGER_ID, ticket, body: `Escalation ${id}`, createdAt: 't1' });

  it('reads back a pending escalation, found by its manager and ticket', () => {
    repository.insertEscalation(anEscalation('e1'));

    expect(repository.findPendingEscalation({ managerId: MANAGER_ID, ticket: TICKET })).toEqual({
      id: 'e1', managerId: MANAGER_ID, ticket: TICKET, status: 'pending', body: 'Escalation e1', createdAt: 't1',
    });
    expect(repository.findPendingEscalation({ managerId: MANAGER_ID, ticket: 'KB-02' })).toBeUndefined();
  });

  it('refuses a second pending escalation on the same ticket, whatever the batch', () => {
    repository.insertEscalation(anEscalation('e1'));

    expect(() => repository.insertEscalation(anEscalation('e2'))).toThrow(/UNIQUE/);
  });

  it('rewrites the body of the open escalation when more questions join it', () => {
    repository.insertEscalation(anEscalation('e1'));

    repository.updateEscalationBody({ id: 'e1', body: 'Escalation e1: 2 questions' });

    expect(repository.findEscalation('e1')!.body).toBe('Escalation e1: 2 questions');
  });

  it('ties a question to its escalation', () => {
    repository.insertQuestion(aQuestion({ route: 'human', status: 'pending_human' }));
    repository.insertEscalation(anEscalation('e1'));

    repository.attachQuestionToEscalation({ batchId: 'b1', questionId: 'q1', escalationId: 'e1' });

    expect(repository.questionsOfBatch('b1')[0]!.escalationId).toBe('e1');
  });

  describe('the answer', () => {
    it('closes a pending escalation once, and the second answer finds it closed', () => {
      repository.insertEscalation(anEscalation('e1'));

      const first = repository.answerEscalationIfPending({ id: 'e1', resolvedAt: 't9' });
      const second = repository.answerEscalationIfPending({ id: 'e1', resolvedAt: 't10' });

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(repository.findEscalation('e1')).toMatchObject({ status: 'answered', resolvedAt: 't9' });
    });

    it('lets the ticket open a new escalation after the answer', () => {
      repository.insertEscalation(anEscalation('e1'));
      repository.answerEscalationIfPending({ id: 'e1', resolvedAt: 't9' });

      expect(() => repository.insertEscalation(anEscalation('e2'))).not.toThrow();
    });

    it('reports false for an escalation that does not exist', () => {
      expect(repository.answerEscalationIfPending({ id: 'nope', resolvedAt: 't9' })).toBe(false);
    });
  });
});

describe('the arbiter decisions', () => {
  beforeEach(() => {
    aBatch();
    repository.insertQuestion(aQuestion());
  });

  const aDecision = {
    batchId: 'b1', questionId: 'q1', verdict: 'decided', decision: 'Uses backoff.', rationale: 'The job is idempotent.', arbiterSessionId: 'a1', planNoteRev: 3, createdAt: 't2',
  } as const;

  it('reads back the decisions of a batch in the order they were recorded', () => {
    repository.insertArbiterDecision(aDecision);
    repository.insertArbiterDecision({ ...aDecision, verdict: 'needs_human', raiseTo: 'security', evidence: { claim: 'c', status: 'proven', command: 'cmd', output: 'out' } });

    const [first, second] = repository.decisionsOfBatch('b1');

    expect(first).toEqual(aDecision);
    expect(second).toMatchObject({ verdict: 'needs_human', raiseTo: 'security', evidence: { claim: 'c', status: 'proven', command: 'cmd', output: 'out' } });
  });

  it('refuses a decision on a question that is not in the batch', () => {
    expect(() => repository.insertArbiterDecision({ ...aDecision, questionId: 'q-unknown' })).toThrow();
  });
});
