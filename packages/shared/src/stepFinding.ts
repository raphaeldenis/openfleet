import * as z from 'zod';
import { CLEAN_PROOF_MESSAGE, isExecutedClaim, ReproClaimSchema } from './reproClaim.js';
import { MAX_VERDICT_REASONS } from './shipVerdict.js';

export const STEP_FINDING_STEPS = ['qe', 'qa', 'ponytail'] as const;
export const STEP_FINDING_SEVERITIES = ['clean', 'findings'] as const;

export const StepFindingSchema = z.object({
  step: z.enum(STEP_FINDING_STEPS),
  severity: z.enum(STEP_FINDING_SEVERITIES),
  claims: z.array(ReproClaimSchema).max(MAX_VERDICT_REASONS),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
})
  .refine((stepFinding) => stepFinding.severity === 'clean' || stepFinding.claims.length >= 1, { message: 'a findings report names at least one claim', path: ['claims'] })
  .refine((stepFinding) => stepFinding.severity === 'findings' || stepFinding.claims.some(isExecutedClaim), { message: CLEAN_PROOF_MESSAGE, path: ['claims'] });

export type StepFinding = z.infer<typeof StepFindingSchema>;
