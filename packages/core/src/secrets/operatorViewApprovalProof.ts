import type { ViewApprovalProof } from '../integrations/viewApprovalProof.js';
import type { NonceLedger } from './nonceLedger.js';

/**
 * The proof of a daemon that has a desktop app: the operator nonce the app minted for the approval of the view of exactly this integration.
 * It shares one mechanism with arming and secret writes, so a nonce for another integration, another action, or one already spent is refused.
 */
export const createOperatorViewApprovalProof = (nonces: Pick<NonceLedger, 'redeem'>): ViewApprovalProof => ({
  consume: (proof, intent) => {
    if (proof === undefined) return false;
    return nonces.redeem(proof, { action: 'integration.approve_view', scope: { kind: 'integration', id: intent.integrationId }, name: intent.integrationId });
  },
});
