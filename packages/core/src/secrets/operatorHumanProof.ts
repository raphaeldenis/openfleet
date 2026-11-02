import type { HumanProofVerifier } from '../triggers/humanProofVerifier.js';
import type { NonceLedger } from './nonceLedger.js';

/**
 * The human proof of a daemon that has a desktop app: the operator nonce the app minted for the arming of exactly this trigger.
 * Arming and secret writes share one mechanism, so a nonce for another trigger, for a secret, or one already spent is refused.
 */
export const createOperatorHumanProof = (nonces: Pick<NonceLedger, 'redeem'>): HumanProofVerifier => ({
  consume: (proof, intent) => {
    if (proof === undefined) return false;
    const triggerBinding = { action: 'trigger.arm' as const, scope: { kind: 'trigger' as const, id: intent.triggerId }, name: intent.triggerId };
    return nonces.redeem(proof, triggerBinding);
  },
});
