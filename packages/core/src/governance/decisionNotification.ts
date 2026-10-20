import type { GovernanceProposalView } from '@openfleet/shared';
import { maskedSecrets } from '../redact.js';
import { wrapAgentMessage } from '../sessions/messageEnvelope.js';
import { visibleTextOf } from './visibleText.js';

const MAX_NOTIFICATION_TEXT_CHARS = 700;

export function decisionNotification(input: { proposal: GovernanceProposalView; reason?: string }): string {
  const { proposal, reason } = input;
  const explanation = reason ?? proposal.denialReason;
  const suffix = explanation === undefined ? '' : `: ${explanation}`;
  const visibleMessage = visibleTextOf(`Proposal ${proposal.id} ${proposal.status}${suffix}`);
  const body = maskedSecrets(visibleMessage).slice(0, MAX_NOTIFICATION_TEXT_CHARS);
  return wrapAgentMessage({ fromSessionId: 'governance', fromBranch: 'governance', messageId: `governance-${proposal.id}`, body });
}
