import * as z from 'zod';

export const REPRO_STATUSES = ['proven', 'plausible', 'not_reproduced'] as const;
export type ReproStatus = (typeof REPRO_STATUSES)[number];

export const MAX_CLAIM_CHARS = 300;
export const MAX_REPRO_COMMAND_CHARS = 300;
export const MAX_REPRO_OUTPUT_CHARS = 1500;

/** The labels people read for each status. */
export const REPRO_STATUS_LABELS: Readonly<Record<ReproStatus, string>> = { proven: 'PROUVÉ', plausible: 'PLAUSIBLE', not_reproduced: 'NON REPRODUIT' };

export const REPRO_CLAIM_EXAMPLE = '{ claim: "the filter is missing", status: "proven", command: "pnpm vitest run filter.test.ts", output: "FAIL filter.test.ts > shows the filter" }';

const statusesUnion = REPRO_STATUSES.join(' | ');
export const SHAPE_MESSAGE = `a claim is { claim, status, command, output }; status is ${statusesUnion}; proven and plausible need the command you ran and its output; not_reproduced says where you read it.`;
const STATUS_MESSAGE = `status is ${statusesUnion}. ${SHAPE_MESSAGE}`;
export const EVIDENCE_MESSAGE = `a proven or plausible claim needs the command you ran and its output. ${SHAPE_MESSAGE}`;

const isGiven = (text: string | undefined): text is string => text !== undefined && text !== '';

/** One claim of a report with the reproduction that backs it: executed (command and output) or labelled not_reproduced. */
export const ReproClaimSchema = z.object({
  claim: z.string().min(1).max(MAX_CLAIM_CHARS),
  status: z.enum(REPRO_STATUSES, { error: () => STATUS_MESSAGE }),
  command: z.string().trim().max(MAX_REPRO_COMMAND_CHARS).optional(),
  output: z.string().trim().max(MAX_REPRO_OUTPUT_CHARS).optional(),
}, { error: () => SHAPE_MESSAGE }).refine(
  (reproClaim) => reproClaim.status === 'not_reproduced' || (isGiven(reproClaim.command) && isGiven(reproClaim.output)),
  { message: EVIDENCE_MESSAGE, path: ['output'] },
);

export type ReproClaim = z.infer<typeof ReproClaimSchema>;

export const CLEAN_PROOF_MESSAGE = 'a clean report or a go carries at least one claim that says what was verified, with status proven or plausible and the command and output of the run (for example { claim: "qe: 321 tests green", status: "proven", command: "pnpm test", output: "321 passed" }).';

/** A claim that stands on a run: proven or plausible, not only read in the code. */
export const isExecutedClaim = ({ status }: ReproClaim): boolean => status !== 'not_reproduced';
