import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ARBITER_ROLE, ArbiterOpinionSchema, ESCALATING_CLASSES, OpenFleetError, REPRO_CLAIM_EXAMPLE, type Session } from '@openfleet/shared';
import { z } from 'zod';
import type { ArbiterRunner } from '../escalation/arbiterRunner.js';
import type { EscalationService } from '../escalation/escalationService.js';
import type { ManagerService } from '../managers/managerService.js';
import { problemOf } from './escalationTools.js';
import { ok, refuse } from './toolResults.js';

/** The only tools an arbiter sees: it reports its opinion to the daemon and can reach its manager. */
export const ARBITER_TOOL_NAMES: ReadonlySet<string> = new Set(['report_arbiter_opinion', 'message_parent']);

export interface RegisterArbiterToolsDeps {
  escalations: Pick<EscalationService, 'recordArbiterOpinion'>;
  arbiters: Pick<ArbiterRunner, 'batchOf' | 'settle' | 'noteRefusedOpinion'>;
  managers: Pick<ManagerService, 'get'>;
  caller: Session;
}

export function registerArbiterTools(server: McpServer, deps: RegisterArbiterToolsDeps): void {
  const { escalations, arbiters, managers, caller } = deps;

  server.registerTool('report_arbiter_opinion', {
    description: `Report your decisions on the batch of questions you were given (arbiters only). { batch_id, decisions: [{ question_id, verdict: decided | needs_human, decision (600 characters, the choice, in the present), rationale (600), raise_to (${ESCALATING_CLASSES.join(' | ')}, optional: a question you hand to a human, never one you lower), evidence (optional, ${REPRO_CLAIM_EXAMPLE}) }], criteria: { opinion: favourable | unfavourable | not_asked, reasons: up to 5 strings, at least one when unfavourable } }. Decide every question of the batch, exactly once: a question missing or foreign to the batch refuses the whole report. A favourable opinion is refused while a question stays with a human. The daemon writes the decisions, the sections of the plan note and the journal itself and tells your manager. Answers { recorded, decided, escalated, ignored, warnings }`,
    inputSchema: { batch_id: z.string(), decisions: z.array(z.unknown()), criteria: z.unknown() },
  }, async (input) => {
    const manager = caller.parentId ? managers.get(caller.parentId) : undefined;
    const isArbiterOfAManager = caller.role === ARBITER_ROLE && manager !== undefined;
    if (!isArbiterOfAManager) return refuse('not_a_manager', 'only an arbiter spawned by a manager can report an opinion');

    const parsedOpinion = ArbiterOpinionSchema.safeParse(input);
    if (!parsedOpinion.success) {
      arbiters.noteRefusedOpinion(caller.id);
      return refuse('invalid_body', parsedOpinion.error.issues.map(problemOf).join('; '), 'Fix the shape, then report again.');
    }
    const opinion = parsedOpinion.data;

    const runBatchId = arbiters.batchOf(caller.id);
    const isBatchOfAnotherRun = runBatchId !== undefined && runBatchId !== opinion.batch_id;
    if (isBatchOfAnotherRun) return refuse('escalation_not_found', 'this batch is not the one you were given');

    try {
      const recorded = escalations.recordArbiterOpinion({ managerId: manager.sessionId, arbiterSessionId: caller.id, opinion });
      arbiters.settle(caller.id);
      return ok({
        recorded: true, decided: recorded.decidedQuestionIds, escalated: recorded.escalatedQuestionIds, ignored: recorded.ignoredQuestionIds,
        ...(recorded.warnings.length > 0 && { warnings: recorded.warnings }),
      });
    } catch (error) {
      const isRefusedOpinion = error instanceof OpenFleetError && error.code === 'invalid_body';
      if (isRefusedOpinion) arbiters.noteRefusedOpinion(caller.id);
      throw error;
    }
  });
}
