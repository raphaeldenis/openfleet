import * as z from 'zod';
import { CLEAN_PROOF_MESSAGE, isExecutedClaim, MAX_CLAIM_CHARS, ReproClaimSchema } from './reproClaim.js';

export const MAX_VERDICT_REASONS = 5;
export const MAX_VERDICT_REASON_CHARS = MAX_CLAIM_CHARS;

export const SHIP_VERDICTS = ['go', 'no-go'] as const;

export const ShipVerdictSchema = z.object({
  verdict: z.enum(SHIP_VERDICTS),
  reasons: z.array(ReproClaimSchema).max(MAX_VERDICT_REASONS),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
})
  .refine((shipVerdict) => shipVerdict.verdict === 'go' || shipVerdict.reasons.length >= 1, { message: 'a no-go names at least one blocking reason', path: ['reasons'] })
  .refine((shipVerdict) => shipVerdict.verdict === 'no-go' || shipVerdict.reasons.some(isExecutedClaim), { message: CLEAN_PROOF_MESSAGE, path: ['reasons'] });

export type ShipVerdict = z.infer<typeof ShipVerdictSchema>;
