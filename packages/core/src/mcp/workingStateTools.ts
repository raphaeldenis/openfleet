import { WorkingStateSectionsSchema, type Session } from '@openfleet/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SessionService } from '../sessions/sessionService.js';
import type { WorkingStateService } from '../workingState/workingStateService.js';
import { guardedFor, ok, refuse } from './toolResults.js';
import { workingStateView } from './toolViews.js';

export interface RegisterWorkingStateToolsDeps {
  workingStates: WorkingStateService;
  sessions: SessionService;
  caller: Session;
}

const sectionShape = WorkingStateSectionsSchema.shape;

export function registerWorkingStateTools(server: McpServer, deps: RegisterWorkingStateToolsDeps): void {
  const { workingStates, sessions, caller } = deps;
  const guarded = guardedFor(caller);
  const isInLineage = (target: Session) => target.id === caller.id || target.parentId === caller.id || target.id === caller.parentId;

  server.registerTool('update_working_state', {
    description: 'Replace your working state: your plan, todo, remaining work, questions for the human, internal questions and blockers. Each is a list of one-line items. Keep the current situation only; history belongs to the log.',
    inputSchema: {
      plan: sectionShape.plan, todo: sectionShape.todo, remaining: sectionShape.remaining,
      questions_for_human: sectionShape.questionsForHuman, internal_questions: sectionShape.internalQuestions, blockers: sectionShape.blockers,
    },
  }, async ({ plan, todo, remaining, questions_for_human, internal_questions, blockers }) => {
    return guarded(() => {
      const { updatedAt, mirrorWarning } = workingStates.update(caller.id, { plan, todo, remaining, questionsForHuman: questions_for_human, internalQuestions: internal_questions, blockers });
      return { updated_at: updatedAt, ...(mirrorWarning ? { mirror_warning: mirrorWarning } : {}) };
    });
  });

  server.registerTool('get_working_state', {
    description: 'The working state of your session, or of one in your lineage; { "state": null } when none is recorded',
    inputSchema: { session_id: z.string().optional() },
  }, async ({ session_id }) => {
    const target = sessions.get(session_id ?? caller.id);
    if (!target || !isInLineage(target)) return refuse('outside_lineage', 'session not found or outside your lineage');
    const state = workingStates.get(target.id);
    return ok(state ? workingStateView(state) : { state: null });
  });
}
