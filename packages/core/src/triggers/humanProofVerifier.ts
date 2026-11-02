export interface HumanProofIntent {
  action: 'arm_trigger';
  triggerId: string;
}

/** Tells whether a proof was minted by a human gesture in the desktop app for this intent; a proof is single-use, so a true answer spends it. */
export interface HumanProofVerifier {
  consume(proof: string | undefined, intent: HumanProofIntent): boolean;
}

/** The verifier of a daemon that has no desktop to mint proofs: no proof is ever good, so nothing is armed. */
export const refusingHumanProof: HumanProofVerifier = { consume: () => false };
