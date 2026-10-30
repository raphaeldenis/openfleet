import type { EscalationView, GovernanceProposalView } from '@openfleet/shared';
import { maskedSecrets } from '../redact.js';
import { wrapAgentMessage } from '../sessions/messageEnvelope.js';
import { visibleTextOf } from './visibleText.js';

const MAX_NOTIFICATION_TEXT_CHARS = 700;

const releaseMention = (releasedProposalId: string) => `Queued proposal ${releasedProposalId} is now pending`;

const MAX_ESCALATION_ANSWER_NOTIFICATION_CHARS = 2400;

/** The message that tells a manager what the human answered to each question of an escalation. */
export function escalationAnswerNotification(escalation: EscalationView): string {
  const answerLines = escalation.questions.map(({ questionId, humanAnswer }) => `${questionId}: ${humanAnswer ?? '(no answer)'}`);
  const text = `Escalation ${escalation.id} on ${escalation.ticket} answered. ${answerLines.join(' | ')}`;
  const body = maskedSecrets(visibleTextOf(text)).slice(0, MAX_ESCALATION_ANSWER_NOTIFICATION_CHARS);
  return wrapAgentMessage({ fromSessionId: 'governance', fromBranch: 'governance', messageId: `escalation-${escalation.id}`, body });
}

export function decisionNotification(input: { proposal: GovernanceProposalView; reason?: string; releasedProposalIds?: string[] }): string {
  const { proposal, reason, releasedProposalIds = [] } = input;
  const explanation = reason ?? proposal.denialReason;
  const suffix = explanation === undefined ? '' : `: ${explanation}`;
  const releaseMentions = releasedProposalIds.map(releaseMention).join('. ');
  const roomForDecision = releaseMentions === '' ? MAX_NOTIFICATION_TEXT_CHARS : Math.max(0, MAX_NOTIFICATION_TEXT_CHARS - releaseMentions.length - '. '.length);
  const decisionText = maskedSecrets(visibleTextOf(`Proposal ${proposal.id} ${proposal.status}${suffix}`)).slice(0, roomForDecision);
  const body = releaseMentions === '' ? decisionText : `${decisionText}. ${releaseMentions}`.slice(0, MAX_NOTIFICATION_TEXT_CHARS);
  return wrapAgentMessage({ fromSessionId: 'governance', fromBranch: 'governance', messageId: `governance-${proposal.id}`, body });
}
