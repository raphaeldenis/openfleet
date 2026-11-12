export interface ManualResumeIntent {
  runId: string;
  seq: number;
}

/** Tells whether a proof was minted by a human gesture in the desktop app for the answer to exactly this manual step; a proof is single-use, so a true answer spends it. */
export interface ManualResumeProof {
  consume(proof: string | undefined, intent: ManualResumeIntent): boolean;
}

/** The proof of a daemon that has no desktop to mint proofs: no proof is ever good, so no manual step is answered. */
export const refusingManualResumeProof: ManualResumeProof = { consume: () => false };
