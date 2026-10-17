import * as z from 'zod';

export const MAX_VERDICT_REASONS = 5;
export const MAX_VERDICT_REASON_CHARS = 300;

export const SHIP_VERDICTS = ['go', 'no-go'] as const;

export const ShipVerdictSchema = z.object({
  verdict: z.enum(SHIP_VERDICTS),
  reasons: z.array(z.string().min(1).max(MAX_VERDICT_REASON_CHARS)).max(MAX_VERDICT_REASONS),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
}).refine((shipVerdict) => shipVerdict.verdict === 'go' || shipVerdict.reasons.length >= 1, { message: 'a no-go names at least one blocking reason', path: ['reasons'] });

export type ShipVerdict = z.infer<typeof ShipVerdictSchema>;
