import { PLAYBOOK_RESUME_ACTION, PLAYBOOK_RUN_SCOPE_KIND } from '@openfleet/shared';
import type { ManualResumeProof } from '../playbooks/manualResumeProof.js';
import type { NonceLedger } from './nonceLedger.js';

/**
 * The proof of a daemon that has a desktop app: the operator nonce the app minted for the answer to exactly this step of this run.
 * It shares one mechanism with arming, view approval and secret writes, so a nonce for another run, another step, another action, or one already spent is refused.
 */
export const createOperatorManualResumeProof = (nonces: Pick<NonceLedger, 'redeem'>): ManualResumeProof => ({
  consume: (proof, { runId, seq }) => {
    if (proof === undefined) return false;
    return nonces.redeem(proof, { action: PLAYBOOK_RESUME_ACTION, scope: { kind: PLAYBOOK_RUN_SCOPE_KIND, id: runId }, name: String(seq) });
  },
});
