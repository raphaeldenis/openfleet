import type { GovernanceProposalView } from '@openfleet/shared';
import { maskedSecrets } from '../redact.js';
import { wrapAgentMessage } from '../sessions/messageEnvelope.js';
import { visibleTextOf } from './visibleText.js';

const MAX_NOTIFICATION_TEXT_CHARS = 700;

const releaseMention = (releasedProposalId: string) => `Queued proposal ${releasedProposalId} is now pending`;

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
