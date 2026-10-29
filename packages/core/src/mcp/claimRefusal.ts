import { REPRO_CLAIM_EXAMPLE, SHAPE_MESSAGE } from '@openfleet/shared';
import { refuse } from './toolResults.js';

const EXAMPLE_HINT = `Example: ${REPRO_CLAIM_EXAMPLE}`;

/** Refuses with invalid_body: the messages state the rule and the hint carries the claim example, so each fits its own cap. */
export function refuseInvalidBody(messages: string[]) {
  const distinctMessages = [...new Set(messages)];
  const explainsClaimForm = distinctMessages.some((message) => message.includes(SHAPE_MESSAGE));
  return refuse('invalid_body', distinctMessages.join('; '), explainsClaimForm ? EXAMPLE_HINT : undefined);
}
