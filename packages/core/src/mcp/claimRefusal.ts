import { EVIDENCE_MESSAGE, EVIDENCE_PROBLEM, REPRO_CLAIM_EXAMPLE, SHAPE_MESSAGE, STATUS_MESSAGE, STATUS_PROBLEM } from '@openfleet/shared';
import { refuse } from './toolResults.js';

const EXAMPLE_HINT = `Example: ${REPRO_CLAIM_EXAMPLE}`;

const SHORT_PROBLEM_OF_MESSAGE = new Map([
  [STATUS_MESSAGE, STATUS_PROBLEM],
  [EVIDENCE_MESSAGE, EVIDENCE_PROBLEM],
]);

/** The specific problem a message reports: its short form when it has one, nothing when it only restates the claim shape. */
const problemsOf = (message: string): string[] => {
  const shortProblem = SHORT_PROBLEM_OF_MESSAGE.get(message);
  const onlyRestatesShape = message === SHAPE_MESSAGE;
  if (shortProblem !== undefined) return [shortProblem];
  return onlyRestatesShape ? [] : [message];
};

/** Refuses with invalid_body: the message states the claim shape once, then lists the specific problems; the hint carries the claim example. */
export function refuseInvalidBody(messages: string[]) {
  const distinctMessages = [...new Set(messages)];
  const explainsClaimForm = distinctMessages.some((message) => message.includes(SHAPE_MESSAGE));
  const problems = [...new Set(distinctMessages.flatMap(problemsOf))];
  const claimFormMessage = [SHAPE_MESSAGE, ...problems].join(' ');
  const message = explainsClaimForm ? claimFormMessage : problems.join(' ');
  return refuse('invalid_body', message, explainsClaimForm ? EXAMPLE_HINT : undefined);
}
