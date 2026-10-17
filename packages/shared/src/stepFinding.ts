import * as z from 'zod';
import { MAX_VERDICT_REASONS, MAX_VERDICT_REASON_CHARS } from './shipVerdict.js';

export const STEP_FINDING_STEPS = ['qe', 'qa', 'ponytail'] as const;
export const STEP_FINDING_SEVERITIES = ['clean', 'findings'] as const;

export const StepFindingSchema = z.object({
  step: z.enum(STEP_FINDING_STEPS),
  severity: z.enum(STEP_FINDING_SEVERITIES),
  claims: z.array(z.string().min(1).max(MAX_VERDICT_REASON_CHARS)).max(MAX_VERDICT_REASONS),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
}).refine((stepFinding) => stepFinding.severity === 'clean' || stepFinding.claims.length >= 1, { message: 'a findings report names at least one claim', path: ['claims'] });

export type StepFinding = z.infer<typeof StepFindingSchema>;
