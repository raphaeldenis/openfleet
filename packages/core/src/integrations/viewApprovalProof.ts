export interface ViewApprovalIntent {
  integrationId: string;
}

/** Tells whether a proof was minted by a human gesture in the desktop app for approving the view of exactly this integration; a proof is single-use, so a true answer spends it. */
export interface ViewApprovalProof {
  consume(proof: string | undefined, intent: ViewApprovalIntent): boolean;
}
