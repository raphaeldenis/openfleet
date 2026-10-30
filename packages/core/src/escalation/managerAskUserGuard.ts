import { MANAGER_ROLE, type Session } from '@openfleet/shared';
import { ASK_USER_QUESTION_TOOL, MANAGER_ASK_USER_RULE_ID } from '../policy/defaultCommandPolicy.js';

export interface ManagerAskUserRefusal {
  ruleId: string;
  reason: string;
  alternative: string;
}

const REFUSAL: ManagerAskUserRefusal = {
  ruleId: MANAGER_ASK_USER_RULE_ID,
  reason: 'This manager was not created as attended by a human, so it does not ask the human in free text: the ladder routes its questions by class.',
  alternative: 'Submit your plan questions with `submit_plan_questions`; the daemon sends a human only the ones that need one. A human who accompanies this manager can recreate the session as attended.',
};

export const isManagerSession = (session: Session): boolean => session.role === MANAGER_ROLE;

/** An attended manager is one a human created as accompanied; the flag is fixed at creation. */
export const isAttendedManager = (session: Session): boolean => isManagerSession(session) && session.attended === true;

/**
 * The daemon-level rule "a supervised manager asks its questions through the ladder", judged apart from the command policy mode:
 * the refusal stands in observe and in enforce. Undefined when the call is not an AskUserQuestion of a manager that lacks the attended flag.
 */
export function managerAskUserRefusalOf({ session, toolName }: { session: Session; toolName: string }): ManagerAskUserRefusal | undefined {
  const isManagerAsking = toolName === ASK_USER_QUESTION_TOOL && isManagerSession(session);
  return isManagerAsking && !isAttendedManager(session) ? REFUSAL : undefined;
}
