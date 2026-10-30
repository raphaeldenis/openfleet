import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ESCALATION_POLICY, type PlanQuestion } from '@openfleet/shared';
import { openDatabase } from '../db/database.js';
import type { AuditWriter } from './auditWriter.js';
import { EscalationRepository } from './escalationRepository.js';
import { EscalationService } from './escalationService.js';

const MANAGER_ID = 'm1';
const TICKET = 'CCM-123';
const provenEvidence = { claim: 'the other helper is faster', status: 'proven', command: 'pnpm bench', output: 'old: 3ms new: 1ms' } as const;

function aServiceOverDecidedQuestion() {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO sessions (id, name, directory, harness, state, state_since, hook_token, mcp_token, created_at) VALUES (?, 'Lead', '/tmp', 'fake', 'idle', 't', 'hook', 'mcp', 't')").run(MANAGER_ID);
  db.prepare("INSERT INTO managers (session_id, pulse_seconds, children_cap, mission_text, created_at) VALUES (?, 3600, 2, 'Lead', 't')").run(MANAGER_ID);
  const repository = new EscalationRepository(db);
  repository.insertBatch({ id: 'b0', managerId: MANAGER_ID, ticket: TICKET, planNoteId: 'n1', planNoteRev: 1, createdAt: 't0' });
  repository.insertQuestion({ batchId: 'b0', questionId: 'q1', text: 'which name?', declaredClass: 'technical', computedClasses: [], effectiveClasses: [], route: 'arbiter', status: 'decided' });
  const journal = vi.fn(() => [] as string[]);
  const audit = { journal, tellManager: vi.fn(), appendDecisionSections: vi.fn() } as unknown as AuditWriter;
  let nextId = 0;
  const service = new EscalationService({
    db, repository, audit, workingStates: { get: () => undefined, update: vi.fn() } as never, clock: () => 't1', newId: () => `id${nextId++}`,
  });
  return { service, repository, journal };
}

const reopeningQuestion: PlanQuestion = { id: 'n1', text: 'how to name the helper', class: 'technical', reopens: 'q1', resolution: provenEvidence };
const batchOf = (questions: PlanQuestion[]) => ({ managerId: MANAGER_ID, ticket: TICKET, planNoteId: 'n1', planNoteRev: 1, questions, policy: DEFAULT_ESCALATION_POLICY });

describe('a reopen whose target cannot be checked', () => {
  it('fails closed to the human as arbiter_dispute: no question waits for the arbiter and nothing is dropped', () => {
    const { service, repository, journal } = aServiceOverDecidedQuestion();
    vi.spyOn(repository, 'decidedQuestionForReopen').mockImplementation(() => { throw new Error('database is locked'); });

    const submitted = service.submitBatch(batchOf([reopeningQuestion]));

    expect(submitted.arbiterQuestionIds).toEqual([]);
    expect(submitted.human?.questionIds).toEqual(['n1']);
    const [stored] = repository.questionsOfBatch(submitted.batchId);
    expect(stored).toMatchObject({ questionId: 'n1', route: 'human', status: 'pending_human', reason: 'arbiter_dispute' });
    expect(stored).not.toHaveProperty('reopensQuestionId');
    expect(journal).toHaveBeenCalledWith(expect.objectContaining({ entries: [expect.stringContaining('arbiter_dispute')] }));
  });

  it('still refuses a reopen without executed evidence when the target cannot be checked', () => {
    const { service, repository } = aServiceOverDecidedQuestion();
    vi.spyOn(repository, 'decidedQuestionForReopen').mockImplementation(() => { throw new Error('database is locked'); });
    const withoutEvidence: PlanQuestion = { id: 'n1', text: 'how to name the helper', class: 'technical', reopens: 'q1' };

    expect(() => service.submitBatch(batchOf([withoutEvidence]))).toThrow(/new evidence/);
  });
});
